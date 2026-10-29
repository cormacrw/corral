import type { Attachment, Epic, EpicDetail, Plan, PlanSession, PlanSessionDetail, RunJob, Task } from '@corral/contracts'
import { richTextToMarkdown } from '@corral/core'
import { schema } from '@corral/db'
import { and, desc, eq, ne } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'

const { agents, epics, runs, tasks } = schema

// The PM over the runner protocol (D9), with a fake runner playing the PM
describe('plan sessions', () => {
  let t: TestApp
  let runner: FakeRunner

  beforeAll(async () => {
    t = await createTestApp('postgres', { listen: true })
    await t.db.update(agents).set({ concurrency: 50 }).where(ne(agents.role, 'pm'))
    runner = await FakeRunner.connect(t.server!.url)
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  const plan = (tasksIn: Partial<{ key: string, ref: string, title: string, description: string, acceptanceCriteria: string[], dependsOn: string[], humanReview: boolean }>[]) => ({
    title: 'Login',
    summary: 'Email and password login',
    tasks: tasksIn.map((task, i) => ({
      key: `t${i + 1}`,
      title: `Task ${i + 1}`,
      description: 'Build it',
      type: 'backend',
      acceptanceCriteria: ['It works'],
      dependsOn: [],
      ...task
    }))
  })

  // The PM finishes a turn: streams a reply and exits cleanly
  async function endTurn(job: RunJob, reply: string, code = 0) {
    runner.send({ type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [{ type: 'message', text: reply }] })
    await sleep(50)
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code }, headSha: null })
    await sleep(150)
  }

  async function session(id: string): Promise<PlanSessionDetail> {
    return t.request('GET', `/api/plan/sessions/${id}`).then(r => r.json()) as Promise<PlanSessionDetail>
  }

  it('starts a session with a PM turn, records questions and plans, and approves the plan', async () => {
    const project = await t.createProject()
    const res = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan a login feature' })
    expect(res.status).toBe(201)
    const created = await res.json() as PlanSessionDetail
    expect(created).toMatchObject({ title: 'Plan a login feature', status: 'none', messages: [{ role: 'human', text: 'Plan a login feature' }] })
    expect(created.activeRunId).not.toBeNull()

    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    expect(job).toMatchObject({ role: 'pm', runtime: 'claude-code', taskId: null, planSessionId: created.id, agentSessionId: null, repository: project.repository })
    expect(job.prompt).toContain('product-manager agent')
    expect(job.prompt).toContain('Plan a login feature')
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'claude-sess-1' })
    await sleep(100)

    // Tools the PM doesn't have are refused by role
    expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'x' })).toMatchObject({ ok: false, error: expect.stringContaining('can’t use') })

    const board = await runner.call(job.runId, job.leaseEpoch, 'list_tasks', {})
    expect(board).toMatchObject({ ok: true, result: { project: { prefix: project.prefix }, tasks: [] } })

    const question = await runner.call(job.runId, job.leaseEpoch, 'ask_question', { question: 'Magic links too?' })
    expect(question).toMatchObject({ ok: true })
    expect((await session(created.id)).messages.at(-1)).toMatchObject({ role: 'pm', kind: 'question', text: 'Magic links too?' })
    expect((await session(created.id)).status).toBe('question')

    const bad = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ dependsOn: ['t2'] }, { dependsOn: ['t1'] }]))
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('cycle') })
    expect(await t.db.select().from(tasks).where(eq(tasks.projectId, project.id))).toHaveLength(0)

    const good = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ title: 'Login form' }, { title: 'Session cookie', dependsOn: ['t1'], humanReview: true }]))
    expect(good).toMatchObject({ ok: true, result: { version: 1, tasks: [{ key: 't1', change: 'added' }, { key: 't2', change: 'added' }] } })
    const detail = await session(created.id)
    expect(detail.status).toBe('needs_approval')
    expect(detail.plans).toHaveLength(1)
    const v1 = detail.plans[0]!
    expect(v1).toMatchObject({ version: 1, status: 'proposed', title: 'Login', tasks: [{ title: 'Login form', change: 'added', status: 'draft', criteriaCount: 1 }, { title: 'Session cookie', dependsOn: [`${project.prefix}-1`] }] })
    expect(detail.messages.at(-1)).toMatchObject({ role: 'pm', planId: v1.id })
    const [epic] = await t.db.select().from(epics).where(eq(epics.id, v1.epicId!))
    expect(epic?.title).toBe('Login')
    const rows = await t.db.select().from(tasks).where(eq(tasks.projectId, project.id))
    expect(rows.map(r => [r.status, r.humanReview, r.epicId])).toEqual([['draft', false, epic!.id], ['draft', true, epic!.id]])
    // Drafts are seen only in the plan, not on the board or in the Backlog
    expect(await t.request('GET', `/api/projects/${project.slug}/tasks?view=all`).then(r => r.json())).toEqual([])

    await endTurn(job, 'I proposed two tasks. Shall I go ahead?')
    const ended = await session(created.id)
    expect(ended.messages.at(-1)).toMatchObject({ role: 'pm', kind: 'message', text: 'I proposed two tasks. Shall I go ahead?' })
    expect(ended.activeRunId).toBeNull()
    expect((await t.db.select().from(runs).where(eq(runs.id, job.runId)))[0]).toMatchObject({ state: 'completed', agentSessionId: 'claude-sess-1' })

    // The next turn resumes the CLI session, with a fallback that carries the record
    const next = await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'Drop the cookie task, add logout' })
    expect(next.status).toBe(201)
    const second = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.runId !== job.runId)).job
    expect(second.agentSessionId).toBe('claude-sess-1')
    expect(second.prompt).not.toContain('product-manager agent')
    expect(second.fallbackPrompt).toContain('Conversation so far')
    expect(second.fallbackPrompt).toContain('Magic links too?')

    const v2 = await runner.call(second.runId, second.leaseEpoch, 'propose_plan', plan([{ title: 'Login form', acceptanceCriteria: ['It works', 'Errors are shown'] }, { key: 't3', title: 'Logout', dependsOn: ['t1'] }]))
    expect(v2).toMatchObject({ ok: true, result: { version: 2, tasks: [{ key: 't1', change: 'changed' }, { key: 't3', change: 'added' }, { key: 't2', change: 'removed' }] } })
    const revised = await session(created.id)
    expect(revised.plans.map(p => [p.version, p.status])).toEqual([[1, 'superseded'], [2, 'proposed']])
    const latest = revised.plans[1]!
    expect(latest.tasks.map(x => [x.key, x.change, x.title])).toEqual([['t1', 'changed', 'Login form'], ['t3', 'added', 'Logout'], ['t2', 'removed', 't2']])
    const drafts = await Promise.all(latest.tasks.filter(x => x.ref).map(x => t.request('GET', `/api/tasks/${x.ref}`).then(r => r.json()) as Promise<Task>))
    expect(drafts.map(x => [x.title, x.status, x.acceptanceCriteria.length])).toEqual([['Login form', 'draft', 2], ['Logout', 'draft', 1]])
    await endTurn(second, 'Updated.')

    // Only a human approves; Add to board makes every Draft Ready
    const approved = await t.request('POST', `/api/plan/plans/${latest.id}/approve`)
    expect(approved.status).toBe(200)
    expect(await approved.json() as Plan).toMatchObject({ status: 'approved', tasks: [{ status: 'ready' }, { status: 'ready' }, { change: 'removed', status: null }] })
    expect((await session(created.id)).status).toBe('none')
    expect((await t.request('POST', `/api/plan/plans/${latest.id}/approve`)).status).toBe(409)
    const list = await t.request('GET', '/api/plan/sessions').then(r => r.json()) as PlanSession[]
    expect(list.find(s => s.id === created.id)).toMatchObject({ status: 'none', unread: false })
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  })

  it('lets the PM read any task by ref, and names a ref that doesn\'t exist', async () => {
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const [epic] = await t.db.insert(epics).values({ projectId: project.id, title: 'Accounts', createdBy: t.actor }).returning()
    const base = await t.createTask(project.slug, { title: 'User table' })
    const task = await t.createTask(project.slug, {
      title: 'Add login',
      epicId: epic!.id,
      dependsOn: [base.number],
      description: { type: 'doc', content: [{ type: 'heading', attrs: { level: 2 }, content: [{ type: 'text', text: 'Why' }] }, { type: 'paragraph', content: [{ type: 'text', text: 'Email and password' }] }] },
      acceptanceCriteria: ['Shows an error on a bad password', 'Remembers the session']
    })
    expect(task.status).toBe('backlog')
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/comments`, { body: 'Use argon2' })).status).toBe(201)

    await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: `Refine ${task.ref}` })
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    const read = await runner.call(job.runId, job.leaseEpoch, 'get_task', { taskRef: task.ref })
    expect(read).toMatchObject({
      ok: true,
      result: {
        ref: task.ref,
        title: 'Add login',
        description: '## Why\n\nEmail and password',
        status: 'backlog',
        epic: { id: epic!.id, title: 'Accounts' },
        dependsOn: [base.ref],
        acceptanceCriteria: [
          { id: task.acceptanceCriteria[0]!.id, text: 'Shows an error on a bad password' },
          { id: task.acceptanceCriteria[1]!.id, text: 'Remembers the session' }
        ],
        comments: [{ author: 'human', body: 'Use argon2' }],
        attachments: []
      }
    })

    const missing = `${project.prefix}-99`
    expect(await runner.call(job.runId, job.leaseEpoch, 'get_task', { taskRef: missing })).toMatchObject({ ok: false, error: `No task ${missing} in this project` })
    expect(await runner.call(job.runId, job.leaseEpoch, 'get_task', { taskRef: 'XYZ-1' })).toMatchObject({ ok: false, error: expect.stringContaining('No task XYZ-1 in this project') })
    await endTurn(job, 'Read it.')
  })

  it('gives the PM an attachment from its own project as an image, and refuses other projects\' and unknown ids', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    const project = await t.createProject()
    const other = await t.createProject()
    const upload = (slug: string) => t.request('POST', `/api/projects/${slug}/attachments?name=login.png`, new Blob([png], { type: 'image/png' })).then(r => r.json()) as Promise<Attachment>
    const own = await upload(project.slug)
    const foreign = await upload(other.slug)

    await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: `Plan from ![login](attachment:${own.id})` })
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    expect(await runner.call(job.runId, job.leaseEpoch, 'get_attachment', { attachmentId: own.id })).toMatchObject({
      ok: true,
      result: { id: own.id, fileName: 'login.png', mimeType: 'image/png', byteSize: png.byteLength, images: [{ mimeType: 'image/png', dataBase64: png.toString('base64') }] }
    })
    for (const id of [foreign.id, '00000000-0000-4000-8000-000000000000', 'nope']) {
      expect(await runner.call(job.runId, job.leaseEpoch, 'get_attachment', { attachmentId: id })).toMatchObject({ ok: false, error: `${id} isn't an attachment in this project` })
    }
    await endTurn(job, 'Looked at it.')
  })

  it('lists a task\'s images in the PM\'s get_task', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const image = await t.request('POST', `/api/projects/${project.slug}/attachments?name=login.png`, new Blob([png], { type: 'image/png' })).then(r => r.json()) as Attachment
    const task = await t.createTask(project.slug, { description: { type: 'doc', content: [{ type: 'image', attrs: { src: `attachment:${image.id}` } }] } })

    await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: `Refine ${task.ref}` })
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    expect(await runner.call(job.runId, job.leaseEpoch, 'get_task', { taskRef: task.ref })).toMatchObject({
      ok: true,
      result: { attachments: [{ id: image.id, fileName: 'login.png', foundIn: ['the description'] }] }
    })
    await endTurn(job, 'Read it.')
  })

  // A Backlog task with a dependency and two criteria, to refine by ref
  async function backlogSetup() {
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const base = await t.createTask(project.slug, { title: 'User table' })
    const other = await t.createTask(project.slug, { title: 'Sessions' })
    const target = await t.createTask(project.slug, {
      title: 'Add login',
      dependsOn: [base.number],
      acceptanceCriteria: ['Shows an error on a bad password', 'Remembers the session']
    })
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: `Refine ${target.ref}` }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.planSessionId === created.id)).job
    const getTask = (ref: string) => t.request('GET', `/api/tasks/${ref}`).then(r => r.json()) as Promise<Task>
    const count = async () => (await t.db.select().from(tasks).where(eq(tasks.projectId, project.id))).length
    // Revises the target by ref (written in lower case) and adds one new task
    const revise = () => runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([
      {
        ref: target.ref.toLowerCase(),
        title: 'Add email login',
        description: '## Why\n\nPasswords only',
        acceptanceCriteria: ['Shows an error on a bad password', 'Locks the account after 5 tries'],
        dependsOn: [other.ref, 't2']
      },
      { title: 'Rate limiter' }
    ]))
    return { project, base, other, target, created, job, getTask, count, revise }
  }

  it('revises a Backlog task by ref without creating a new one, staging the edits until Add to backlog', async () => {
    const { project, base, other, target, created, job, getTask, count, revise } = await backlogSetup()
    expect(await count()).toBe(3)

    const proposed = await revise()
    expect(proposed).toMatchObject({ ok: true, result: { version: 1, tasks: [{ key: 't1', ref: target.ref, change: 'added', revises: true }, { key: 't2', change: 'added', revises: false }] } })
    // Only the new task is created; the referenced one is untouched
    expect(await count()).toBe(4)
    const before = await getTask(target.ref)
    expect(before).toMatchObject({ title: 'Add login', status: 'backlog', dependsOn: [base.ref], epicId: null })
    expect(before.acceptanceCriteria.map(c => [c.id, c.text])).toEqual(target.acceptanceCriteria.map(c => [c.id, c.text]))
    expect(richTextToMarkdown(before.description)).toBe('Email and password')

    // The plan shows the staged edits under the task's own ref
    const [v1] = (await session(created.id)).plans
    const rateLimiter = v1!.tasks[1]!.ref!
    expect(v1!.tasks).toMatchObject([
      { key: 't1', ref: target.ref, revises: true, title: 'Add email login', status: 'backlog', criteriaCount: 2, dependsOn: [other.ref, rateLimiter], epicId: v1!.epicId },
      { key: 't2', revises: false, title: 'Rate limiter', status: 'draft' }
    ])
    await endTurn(job, 'Proposed.')

    const approved = await t.request('POST', `/api/plan/plans/${v1!.id}/approve`, { to: 'backlog' })
    expect(approved.status).toBe(200)
    const after = await getTask(target.ref)
    expect(after).toMatchObject({ title: 'Add email login', status: 'backlog', dependsOn: [other.ref, rateLimiter], epicId: v1!.epicId })
    expect(richTextToMarkdown(after.description)).toBe('## Why\n\nPasswords only')
    // The unchanged criterion keeps its ID; the new one gets its own
    expect(after.acceptanceCriteria.map(c => c.text)).toEqual(['Shows an error on a bad password', 'Locks the account after 5 tries'])
    expect(after.acceptanceCriteria[0]!.id).toBe(target.acceptanceCriteria[0]!.id)
    expect(after.acceptanceCriteria[1]!.id).not.toBe(target.acceptanceCriteria[1]!.id)
    expect((await getTask(rateLimiter)).status).toBe('backlog')
    expect(await count()).toBe(4)

    const audit = await t.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.taskId, target.id), eq(schema.auditLog.action, 'task.revised')))
    expect(audit).toEqual([expect.objectContaining({ actor: t.actor, detail: expect.objectContaining({ planId: v1!.id, version: 1 }) })])
    void project
  })

  it('moves a revised Backlog task to Ready with its edits on Add to board', async () => {
    const { other, target, created, job, getTask, revise } = await backlogSetup()
    expect(await revise()).toMatchObject({ ok: true })
    await endTurn(job, 'Proposed.')
    const [v1] = (await session(created.id)).plans
    const approved = await t.request('POST', `/api/plan/plans/${v1!.id}/approve`, { to: 'ready' })
    expect(approved.status).toBe(200)
    expect(await approved.json() as Plan).toMatchObject({ tasks: [{ ref: target.ref, revises: true, status: 'ready' }, { revises: false, status: 'ready' }] })
    const after = await getTask(target.ref)
    expect(after).toMatchObject({ title: 'Add email login', status: 'ready', dependsOn: [other.ref, v1!.tasks[1]!.ref] })
    expect(after.acceptanceCriteria.map(c => c.text)).toEqual(['Shows an error on a bad password', 'Locks the account after 5 tries'])
    expect(after.acceptanceCriteria[0]!.id).toBe(target.acceptanceCriteria[0]!.id)
    expect(await t.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.taskId, target.id), eq(schema.auditLog.action, 'task.revised')))).toHaveLength(1)
  })

  it('only un-stages a revised task a later version drops, never deleting or changing it', async () => {
    const { target, created, job, getTask, count, revise } = await backlogSetup()
    expect(await revise()).toMatchObject({ ok: true })
    const v2 = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ key: 't2', title: 'Rate limiter' }]))
    expect(v2).toMatchObject({ ok: true, result: { version: 2, tasks: [{ key: 't2', change: 'unchanged' }, { key: 't1', ref: target.ref, change: 'removed' }] } })
    await endTurn(job, 'Dropped it.')
    expect(await count()).toBe(4)
    const latest = (await session(created.id)).plans[1]!
    expect((await t.request('POST', `/api/plan/plans/${latest.id}/approve`, { to: 'ready' })).status).toBe(200)
    const after = await getTask(target.ref)
    expect(after).toMatchObject({ title: 'Add login', status: 'backlog', acceptanceCriteria: target.acceptanceCriteria.map(c => ({ id: c.id, text: c.text })) })
    expect(await t.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.taskId, target.id), eq(schema.auditLog.action, 'task.revised')))).toEqual([])
  })

  it('rejects a ref that is unknown, deleted, from another project or past the Backlog, saying why', async () => {
    const { project, target, job, count } = await backlogSetup()
    const deleted = await t.createTask(project.slug, { title: 'Old idea' })
    expect((await t.request('DELETE', `/api/projects/${project.slug}/tasks/${deleted.number}`)).status).toBe(204)
    const started = await t.createTask(project.slug, { title: 'Started' })
    await t.db.update(tasks).set({ status: 'ready' }).where(eq(tasks.id, started.id))
    const elsewhere = await t.createProject()
    const foreign = await t.createTask(elsewhere.slug, { title: 'Foreign' })
    const tasksBefore = await count()

    const propose = (ref: string) => runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ ref, title: 'Revised' }]))
    expect(await propose(`${project.prefix}-999`)).toMatchObject({ ok: false, error: expect.stringContaining(`There is no task ${project.prefix}-999 in this project`) })
    expect(await propose(deleted.ref)).toMatchObject({ ok: false, error: expect.stringContaining(`${deleted.ref} was deleted`) })
    expect(await propose(foreign.ref)).toMatchObject({ ok: false, error: expect.stringContaining(`${foreign.ref} belongs to the project`) })
    expect(await propose(started.ref)).toMatchObject({ ok: false, error: expect.stringContaining(`${started.ref} is ready; only Backlog tasks can be revised`) })
    // A dependency may name any existing task, but not a deleted one
    expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ dependsOn: [deleted.ref] }]))).toMatchObject({ ok: false, error: expect.stringContaining('deleted_ref') })
    expect(await count()).toBe(tasksBefore)
    expect((await t.request('GET', `/api/tasks/${target.ref}`).then(r => r.json()) as Task).title).toBe('Add login')
    await endTurn(job, 'Nothing saved.')
  })

  it('spans several epics, keeping each one a revision still names and deleting the one it drops', async () => {
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan accounts' }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    const epicsIn = [{ key: 'e1', title: 'Login' }, { key: 'e2', title: 'Billing' }, { key: 'e3', title: 'Audit' }]

    // A task must say which epic it's in once there are several
    const unplaced = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', { ...plan([{}]), epics: epicsIn.slice(0, 2) })
    expect(unplaced).toMatchObject({ ok: false, error: expect.stringContaining('unknown_epic') })

    const v1 = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', {
      ...plan([{ title: 'Login form' }, { title: 'Invoices', dependsOn: ['t1'] }, { title: 'Audit log' }]),
      epics: epicsIn,
      tasks: plan([{ title: 'Login form' }, { title: 'Invoices', dependsOn: ['t1'] }, { title: 'Audit log' }]).tasks.map((x, i) => ({ ...x, epic: `e${i + 1}` }))
    })
    expect(v1).toMatchObject({ ok: true })
    const first = (await session(created.id)).plans[0]!
    expect(first.epics.map(e => [e.key, e.title])).toEqual([['e1', 'Login'], ['e2', 'Billing'], ['e3', 'Audit']])
    expect(first.epicId).toBe(first.epics[0]!.id)
    expect(first.tasks.map(x => x.epicId)).toEqual(first.epics.map(e => e.id))

    // v2 renames Billing, moves the login form into it and drops Audit
    const v2 = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', {
      ...plan([]),
      epics: [{ key: 'e1', title: 'Login' }, { key: 'e2', title: 'Payments' }],
      tasks: [
        { key: 't1', epic: 'e2', title: 'Login form', description: 'Build it', type: 'backend', acceptanceCriteria: ['It works'] },
        { key: 't2', epic: 'e2', title: 'Invoices', description: 'Build it', type: 'backend', acceptanceCriteria: ['It works'], dependsOn: ['t1'] },
        { key: 't4', epic: 'e1', title: 'Logout', description: 'Build it', type: 'backend', acceptanceCriteria: ['It works'] }
      ]
    })
    expect(v2).toMatchObject({ ok: true, result: { tasks: [{ key: 't1', change: 'changed' }, { key: 't2', change: 'unchanged' }, { key: 't4', change: 'added' }, { key: 't3', change: 'removed' }] } })
    const second = (await session(created.id)).plans[1]!
    expect(second.epics.map(e => [e.key, e.id, e.title])).toEqual([['e1', first.epics[0]!.id, 'Login'], ['e2', first.epics[1]!.id, 'Payments']])
    expect(second.tasks.filter(x => x.ref).map(x => x.epicId)).toEqual([first.epics[1]!.id, first.epics[1]!.id, first.epics[0]!.id])
    expect(await t.db.select().from(epics).where(eq(epics.id, first.epics[2]!.id))).toEqual([])
    await endTurn(job, 'Proposed.')
  })

  it('shows an epic with its tasks, Drafts included, and saves edits to it', async () => {
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan export' }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ title: 'CSV export' }, { key: 't2', title: 'Export button', dependsOn: ['t1'] }]))).toMatchObject({ ok: true })
    await endTurn(job, 'Proposed.')
    const [proposed] = (await session(created.id)).plans

    const epics = await t.request('GET', `/api/projects/${project.slug}/epics`).then(r => r.json()) as Epic[]
    expect(epics).toEqual([expect.objectContaining({ id: proposed!.epicId, title: 'Login', taskCount: 0, mergedCount: 0 })])
    const detail = await t.request('GET', `/api/epics/${proposed!.epicId}`).then(r => r.json()) as EpicDetail
    expect(detail.tasks.map(x => [x.title, x.status, x.dependsOn])).toEqual([['CSV export', 'draft', []], ['Export button', 'draft', [`${project.prefix}-1`]]])

    const patched = await t.request('PATCH', `/api/epics/${proposed!.epicId}`, { title: 'Exports', description: '## Why\n\nPeople want their data.' })
    expect(await patched.json()).toMatchObject({ title: 'Exports', description: '## Why\n\nPeople want their data.' })
    expect(t.events.some(e => e.type === 'epic.updated' && e.epic.title === 'Exports')).toBe(true)
    expect((await t.request('GET', '/api/epics/not-an-id')).status).toBe(404)
  })

  it('lets the PM approve a plan when the human asks in chat, recorded as the human\'s approval', async () => {
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan dark mode' }).then(r => r.json()) as PlanSessionDetail
    const first = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    expect(await runner.call(first.runId, first.leaseEpoch, 'propose_plan', plan([{ title: 'Theme toggle' }]))).toMatchObject({ ok: true })
    // Not in the turn that proposed it: the human hasn't seen the plan yet
    expect(await runner.call(first.runId, first.leaseEpoch, 'approve_plan', { to: 'ready' })).toMatchObject({ ok: false, error: expect.stringContaining('hasn\'t replied') })
    await endTurn(first, 'Proposed.')

    await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'Looks good, add it to the backlog' })
    const second = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id && m.job.runId !== first.runId)).job
    expect(await runner.call(second.runId, second.leaseEpoch, 'approve_plan', { to: 'backlog' })).toMatchObject({ ok: true })
    const [approvedPlan] = (await session(created.id)).plans
    expect(approvedPlan).toMatchObject({ status: 'approved', tasks: [{ status: 'backlog' }] })
    const [audit] = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'plan.approved')).orderBy(desc(schema.auditLog.id)).limit(1)
    expect(audit).toMatchObject({ actor: t.actor, detail: { to: 'backlog', viaPmRun: second.runId } })
    // Once approved there's nothing left to approve
    expect(await runner.call(second.runId, second.leaseEpoch, 'approve_plan', { to: 'ready' })).toMatchObject({ ok: false, error: expect.stringContaining('no plan waiting') })
    await endTurn(second, 'Added.')
  })

  it('adds a plan\'s Drafts to the Backlog instead of the board', async () => {
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const res = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan search' })
    const created = await res.json() as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ title: 'Search box' }]))).toMatchObject({ ok: true })
    await endTurn(job, 'Proposed.')
    const [proposed] = (await session(created.id)).plans
    const approved = await t.request('POST', `/api/plan/plans/${proposed!.id}/approve`, { to: 'backlog' })
    expect(approved.status).toBe(200)
    expect(await approved.json() as Plan).toMatchObject({ status: 'approved', tasks: [{ status: 'backlog' }] })
    const backlog = await t.request('GET', `/api/projects/${project.slug}/tasks?view=backlog`).then(r => r.json()) as Task[]
    expect(backlog.map(x => x.title)).toEqual(['Search box'])
  })

  it('refuses a second turn while one is running, and reports a turn that crashed', async () => {
    const project = await t.createProject()
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Hello' }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    expect((await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'Again' })).status).toBe(409)
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 1 }, headSha: null })
    await sleep(150)
    const detail = await session(created.id)
    expect(detail.messages.at(-1)).toMatchObject({ role: 'pm', kind: 'error', text: 'The PM exited with code 1' })
    expect(detail.activeRunId).toBeNull()
  })

  it('names a renamed PM in the errors of turns that fail', async () => {
    const [pm] = await t.db.select().from(agents).where(eq(agents.role, 'pm'))
    await t.db.update(agents).set({ name: 'Iris' }).where(eq(agents.id, pm!.id))
    try {
      const project = await t.createProject()
      const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Hello' }).then(r => r.json()) as PlanSessionDetail
      const first = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
      const resetsAt = '2030-01-01T00:00:00.000Z'
      runner.send({ type: 'run.ended', runId: first.runId, leaseEpoch: first.leaseEpoch, exit: { kind: 'rate_limited', resetsAt }, headSha: null })
      await sleep(150)
      expect((await session(created.id)).messages.at(-1)).toMatchObject({ role: 'pm', kind: 'error', text: `Iris hit a usage limit; try again after ${resetsAt}` })

      await t.db.update(agents).set({ pausedUntil: null }).where(eq(agents.id, pm!.id))
      await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'Again' })
      const second = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.planSessionId === created.id)).job
      runner.send({ type: 'run.ended', runId: second.runId, leaseEpoch: second.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
      await sleep(150)
      expect((await session(created.id)).messages.at(-1)).toMatchObject({ role: 'pm', kind: 'error', text: 'Iris finished without replying' })
    } finally {
      await t.db.update(agents).set({ name: pm!.name, pausedUntil: null }).where(eq(agents.id, pm!.id))
    }
  })

  it('runs one turn at a time per session, not per project', async () => {
    await t.db.update(agents).set({ concurrency: 50 }).where(eq(agents.role, 'pm'))
    const project = await t.createProject()
    const assigned = (sessionId: string) => runner.next('run.assign', m => m.job.planSessionId === sessionId).then(m => m.job)
    const a = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan search' }).then(r => r.json()) as PlanSessionDetail
    const aJob = await assigned(a.id)
    const b = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan billing' }).then(r => r.json()) as PlanSessionDetail
    const bJob = await assigned(b.id)
    await endTurn(bJob, 'Billing noted.')
    expect((await session(b.id)).activeRunId).toBeNull()

    // A's turn is still running; B's next message starts B's own turn
    const res = await t.request('POST', `/api/plan/sessions/${b.id}/messages`, { text: 'Add invoices' })
    expect(res.status).toBe(201)
    const bNext = await assigned(b.id)
    expect(bNext).toMatchObject({ role: 'pm', projectId: project.id, planSessionId: b.id })

    // Each session shows only its own run as active
    const c = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan audit' }).then(r => r.json()) as PlanSessionDetail
    const cJob = await assigned(c.id)
    await endTurn(cJob, 'Audit noted.')
    expect((await session(a.id)).activeRunId).toBe(aJob.runId)
    expect((await session(b.id)).activeRunId).toBe(bNext.runId)
    expect((await session(c.id)).activeRunId).toBeNull()
    const list = await t.request('GET', '/api/plan/sessions').then(r => r.json()) as PlanSession[]
    expect(list.filter(x => [a.id, b.id, c.id].includes(x.id)).map(x => [x.id, x.activeRunId])).toEqual(expect.arrayContaining([
      [a.id, aJob.runId], [b.id, bNext.runId], [c.id, null]
    ]))

    // A session whose own turn is active still refuses a second one
    const again = await t.request('POST', `/api/plan/sessions/${a.id}/messages`, { text: 'Again' })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: { code: 'conflict', constraint: 'pm_turn_in_progress' } })

    await endTurn(aJob, 'Search planned.')
    await endTurn(bNext, 'Invoices added.')
    expect((await session(a.id)).activeRunId).toBeNull()
    expect((await session(b.id)).activeRunId).toBeNull()
  })

  it('queues a turn over the PM\'s concurrency and starts it when a slot frees', async () => {
    await t.db.update(agents).set({ concurrency: 1 }).where(eq(agents.role, 'pm'))
    const project = await t.createProject()
    const other = await t.createProject()
    const a = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan search' }).then(r => r.json()) as PlanSessionDetail
    const aJob = (await runner.next('run.assign', m => m.job.planSessionId === a.id)).job
    runner.send({ type: 'run.started', runId: aJob.runId, leaseEpoch: aJob.leaseEpoch, agentSessionId: 'claude-a' })

    // Concurrency is global (D13): a session in another project waits too
    const res = await t.request('POST', '/api/plan/sessions', { projectId: other.id, text: 'Plan billing' })
    expect(res.status).toBe(201)
    const b = await res.json() as PlanSessionDetail
    expect(b.activeRunId).not.toBeNull()
    await sleep(200)
    expect(runner.received.some(m => m.type === 'run.assign' && m.job.planSessionId === b.id)).toBe(false)
    const [waiting] = await t.db.select().from(runs).where(eq(runs.id, b.activeRunId!))
    expect(waiting).toMatchObject({ state: 'queued', planSessionId: b.id })
    // Still B's own turn, so B refuses another message meanwhile
    expect((await t.request('POST', `/api/plan/sessions/${b.id}/messages`, { text: 'Again' })).status).toBe(409)

    await endTurn(aJob, 'Search planned.')
    const bJob = (await runner.next('run.assign', m => m.job.planSessionId === b.id)).job
    expect(bJob).toMatchObject({ runId: b.activeRunId, role: 'pm', projectId: other.id, prompt: expect.stringContaining('Plan billing') })
    expect((await session(a.id)).activeRunId).toBeNull()
    expect((await session(b.id)).activeRunId).toBe(bJob.runId)
    await endTurn(bJob, 'Billing planned.')
    expect((await session(b.id)).activeRunId).toBeNull()
    await t.db.update(agents).set({ concurrency: 50 }).where(eq(agents.role, 'pm'))
  })

  it('leaves the plan session alone when the last task of an epic merges', async () => {
    const project = await t.createProject()
    await t.request('PATCH', `/api/projects/${project.slug}`, { requiredChecks: ['lint'] })
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Ship it' }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ title: 'Only task' }]))
    await endTurn(job, 'Proposed.')
    const planId = (await session(created.id)).plans[0]!.id
    await t.request('POST', `/api/plan/plans/${planId}/approve`)

    // Developer and reviewer runs, then the merge
    await t.orchestrator.schedule()
    const dev = (await runner.next('run.assign', m => m.job.role === 'developer' && m.job.projectId === project.id)).job
    const task = await t.request('GET', `/api/tasks/${dev.taskRef}`).then(r => r.json()) as Task
    t.github.setBranch(project.repository, dev.branch!, 'abc123')
    await runner.call(dev.runId, dev.leaseEpoch, 'attach_evidence', { criterionId: task.acceptanceCriteria[0]!.id, kind: 'text', fileName: 'n.txt', contentType: 'text/plain', dataBase64: Buffer.from('x').toString('base64') })
    await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', summary: 'Done', headSha: 'abc123' })
    await t.orchestrator.schedule()
    const review = (await runner.next('run.assign', m => m.job.role === 'reviewer' && m.job.taskId === task.id)).job
    await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Good', criteria: [{ criterionId: task.acceptanceCriteria[0]!.id, met: true, note: '' }] })
    t.github.setChecks('abc123', [{ name: 'lint', conclusion: 'success', url: null }])
    await t.orchestrator.merges.tick()
    expect((await t.request('GET', `/api/tasks/${dev.taskRef}`).then(r => r.json()) as Task).status).toBe('merged')

    // Merged work isn't handed back to the PM: no turn, nothing unread
    await sleep(100)
    expect(runner.received.filter(m => m.type === 'run.assign' && m.job.role === 'pm' && m.job.projectId === project.id && m.job.runId !== job.runId)).toHaveLength(0)
    expect((await session(created.id)).unread).toBe(false)
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  })
})
