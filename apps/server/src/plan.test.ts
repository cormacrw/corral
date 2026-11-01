import { databaseFixture } from '@corral/db/testing'
import type { Attachment, Comment, DraftSession, Epic, EpicDetail, Plan, PlanSession, PlanSessionDetail, RunJob, Task } from '@corral/contracts'
import { richTextToMarkdown } from '@corral/core'
import { schema } from '@corral/db'
import { and, desc, eq, inArray, ne } from 'drizzle-orm'
import { writeFile } from 'node:fs/promises'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'

const { agents, epics, runs, tasks } = schema

// The PM over the runner protocol (D9), with a fake runner playing the PM
describe('plan sessions', () => {
  let t: TestApp
  let runner: FakeRunner

  databaseFixture('postgres', async () => {
    t = await createTestApp('postgres', { listen: true })
    await t.db.update(agents).set({ concurrency: 50 }).where(ne(agents.role, 'pm'))
    runner = await FakeRunner.connect(t.server!.url)
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  const plan = (tasksIn: Partial<{ key: string, ref: string, title: string, type: string, description: string, acceptanceCriteria: string[], dependsOn: string[], priority: string, humanReview: boolean, design: { taskRef: string, version: number, screens: string[] } }>[]) => ({
    title: 'Login',
    summary: 'Email and password login',
    tasks: tasksIn.map((task, i) => ({
      key: `t${i + 1}`,
      title: `Task ${i + 1}`,
      description: 'Build it',
      type: 'task',
      acceptanceCriteria: ['It works'],
      dependsOn: [],
      ...task
    }))
  })

  // The PM finishes a turn: streams a reply and exits cleanly
  async function endTurn(job: RunJob, reply: string, code = 0) {
    const before = t.events.length
    runner.send({ type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [{ type: 'message', text: reply }] })
    await sleep(50)
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code }, headSha: null })
    await vi.waitFor(() => {
      expect(t.events.slice(before).find(e => e.type === 'plan.session' && e.session.id === job.planSessionId && e.session.activeRunId === null)).toBeDefined()
    })
  }

  async function session(id: string): Promise<PlanSessionDetail> {
    return t.request('GET', `/api/plan/sessions/${id}`).then(r => r.json()) as Promise<PlanSessionDetail>
  }

  it('proposes human checks, preserves them on approval, and lets the human toggle them without replacing IDs', async () => {
    const project = await t.createProject()
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan device playback' }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.planSessionId === created.id)).job
    // Mobile PM cards need the persisted session and project on run responses.
    expect(await t.request('GET', `/api/runs/${job.runId}`).then(r => r.json())).toMatchObject({
      planSessionId: created.id, projectId: project.id
    })
    expect(await t.request('GET', '/api/runs').then(r => r.json())).toEqual(
      expect.arrayContaining([expect.objectContaining({ id: job.runId, planSessionId: created.id, projectId: project.id })])
    )
    expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', {
      title: 'Device playback', tasks: [{ key: 'playback', title: 'Playback', description: 'Support playback', type: 'task', acceptanceCriteria: [{ text: 'Works on a real iPhone', checkedByHuman: true }, 'Shows playback controls'] }]
    })).toMatchObject({ ok: true })
    const detail = await session(created.id)
    const proposed = detail.plans[0]!
    const res = await t.request('POST', `/api/plan/plans/${proposed.id}/approve`, { to: 'backlog' })
    expect(res.status).toBe(200)
    const [row] = await t.db.select().from(tasks).where(eq(tasks.projectId, project.id))
    const path = `/api/projects/${project.slug}/tasks/${row!.number}`
    const task = await t.request('GET', path).then(r => r.json()) as Task
    expect(task.acceptanceCriteria[0]).toMatchObject({ text: 'Works on a real iPhone', checkedByHuman: true })
    const changed = await t.request('PATCH', path, { acceptanceCriteria: task.acceptanceCriteria.map(c => ({ id: c.id, text: c.text, checkedByHuman: false })) }).then(r => r.json()) as Task
    expect(changed.acceptanceCriteria[0]).toMatchObject({ id: task.acceptanceCriteria[0]!.id, checkedByHuman: false })
  })

  it.each(['draft', 'backlog'] as const)('preserves a human-set flag when re-proposing a %s with strings or omitted flags, but accepts an explicit false', async (status) => {
    const project = await t.createProject()
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    const start = async () => {
      const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan device playback' }).then(r => r.json()) as PlanSessionDetail
      return { id: created.id, job: (await runner.next('run.assign', m => m.job.planSessionId === created.id)).job }
    }
    let pm = await start()
    const propose = async (criteria: (string | { text: string, checkedByHuman?: boolean })[], ref?: string) => {
      expect(await runner.call(pm.job.runId, pm.job.leaseEpoch, 'propose_plan', {
        title: 'Device playback', tasks: [{ key: 'playback', ...(ref && { ref }), title: 'Playback', description: 'Support playback', type: 'task', acceptanceCriteria: criteria }]
      })).toMatchObject({ ok: true })
    }
    const approve = async () => {
      const plans = (await session(pm.id)).plans
      expect((await t.request('POST', `/api/plan/plans/${plans.at(-1)!.id}/approve`, { to: 'backlog' })).status).toBe(200)
      await endTurn(pm.job, 'Plan approved')
    }
    await propose(['Works on a real iPhone', 'Shows playback controls'])
    const [row] = await t.db.select().from(tasks).where(eq(tasks.projectId, project.id))
    const path = `/api/projects/${project.slug}/tasks/${row!.number}`
    const getTask = () => t.request('GET', path).then(r => r.json()) as Promise<Task>
    const original = await getTask()
    const criterion = original.acceptanceCriteria[0]!
    await t.request('PATCH', path, { acceptanceCriteria: original.acceptanceCriteria.map(c => ({ id: c.id, text: c.text, checkedByHuman: c.id === criterion.id })) })
    if (status === 'backlog') {
      await approve()
      pm = await start()
    }
    const ref = status === 'backlog' ? original.ref : undefined
    // Strings and objects with no flag must both retain the human's choice.
    for (const input of [criterion.text, { text: criterion.text }]) {
      await propose([input, 'Shows playback controls'], ref)
      if (status === 'backlog') {
        await approve()
        pm = await start()
      }
      expect((await getTask()).acceptanceCriteria[0]).toMatchObject({ id: criterion.id, checkedByHuman: true })
    }
    await propose([{ text: criterion.text, checkedByHuman: false }, 'Shows playback controls', 'Shows elapsed time'], ref)
    if (status === 'backlog') await approve()
    const changed = await getTask()
    expect(changed.acceptanceCriteria[0]).toMatchObject({ id: criterion.id, checkedByHuman: false })
    expect(changed.acceptanceCriteria[2]).toMatchObject({ text: 'Shows elapsed time', checkedByHuman: false })
    if (status === 'draft') await endTurn(pm.job, 'Plan proposed')
  })

  it('stores current and legacy wire plans with the same content', async () => {
    const snapshots = []
    const base = plan([{}])
    const epic = { title: 'Accounts', summary: 'Login feature' }
    for (const input of [
      { ...base, epic },
      { ...base, epics: [{ key: 'main', ...epic }], tasks: base.tasks.map(task => ({ ...task, epic: 'main', priority: 'medium', humanReview: false })) }
    ]) {
      const project = await t.createProject()
      const res = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan login' })
      const created = await res.json() as PlanSessionDetail
      const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
      expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', input)).toMatchObject({ ok: true })
      const stored = (await session(created.id)).plans[0]!
      const [task] = await t.db.select().from(tasks).where(eq(tasks.projectId, project.id))
      snapshots.push({ title: stored.title, summary: stored.summary, epics: stored.epics.map(e => ({ key: e.key, title: e.title })), task: { title: task!.title, description: task!.description, type: task!.type, priority: task!.priority, humanReview: task!.humanReview } })
      await endTurn(job, 'Plan proposed')
    }
    expect(snapshots[0]).toEqual(snapshots[1])
  })

  it('starts a session with a PM turn, records questions and plans, and approves the plan', async () => {
    const project = await t.createProject()
    const res = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan a login feature' })
    expect(res.status).toBe(201)
    const created = await res.json() as PlanSessionDetail
    expect(created).toMatchObject({ title: 'Plan a login feature', status: 'none', messages: [{ role: 'human', text: 'Plan a login feature' }] })
    expect(created.activeRunId).toBeNull()

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
    expect(v1).toMatchObject({ version: 1, status: 'proposed', title: 'Login', tasks: [{ title: 'Login form', change: 'added', status: 'draft', priority: 'medium', humanReview: false }, { title: 'Session cookie', priority: 'medium', humanReview: true, dependsOn: [`${project.prefix}-1`] }] })
    expect(v1.tasks[0]).not.toHaveProperty('criteriaCount')
    expect(detail.messages.at(-1)).toMatchObject({ role: 'pm', planId: v1.id })
    // A plan without epics creates none, and its tasks have no epic
    expect(v1).toMatchObject({ epicId: null, epics: [] })
    expect(await t.db.select().from(epics).where(eq(epics.projectId, project.id))).toEqual([])
    const rows = await t.db.select().from(tasks).where(eq(tasks.projectId, project.id)).orderBy(tasks.number)
    expect(rows.map(r => [r.status, r.humanReview, r.epicId])).toEqual([['draft', false, null], ['draft', true, null]])
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
    // Approving to the board closes the session
    expect(list.find(s => s.id === created.id)).toMatchObject({ status: 'none', closed: true })
    expect(t.events.findLast(e => e.type === 'plan.session' && e.session.id === created.id)).toMatchObject({ session: { closed: true } })
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  })

  it('records a question\'s optional recommendation and options, and shows them in the PM\'s history', async () => {
    const project = await t.createProject()
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan exports' }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.planSessionId === created.id)).job
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'claude-sess-q' })
    await sleep(100)

    // A plain question has neither
    expect(await runner.call(job.runId, job.leaseEpoch, 'ask_question', { question: 'Who uses exports?' })).toMatchObject({ ok: true })
    expect((await session(created.id)).messages.at(-1)).toMatchObject({ kind: 'question', text: 'Who uses exports?', recommendation: null, options: null })

    // Invalid options are refused with a tool error, and nothing is recorded
    const count = (await session(created.id)).messages.length
    for (const [options, error] of [
      [['CSV'], 'Give 2–5 options'],
      [['a', 'b', 'c', 'd', 'e', 'f'], 'Give 2–5 options'],
      [['CSV', '  '], 'can’t be empty'],
      [['CSV', 'x'.repeat(121)], 'at most 120 characters'],
      ['CSV', 'options']
    ] as const) {
      expect(await runner.call(job.runId, job.leaseEpoch, 'ask_question', { question: 'Which format?', options })).toMatchObject({ ok: false, error: expect.stringContaining(error) })
    }
    expect(await runner.call(job.runId, job.leaseEpoch, 'ask_question', { question: 'Which format?', recommendation: '' })).toMatchObject({ ok: false, error: expect.stringContaining('recommendation') })
    expect((await session(created.id)).messages).toHaveLength(count)

    // With both, the GET and the plan.message event carry them
    const asked = await runner.call(job.runId, job.leaseEpoch, 'ask_question', { question: 'Which format?', recommendation: 'CSV', options: ['CSV', ' Excel ', 'JSON'] })
    expect(asked).toMatchObject({ ok: true })
    const expected = { kind: 'question', text: 'Which format?', recommendation: 'CSV', options: ['CSV', 'Excel', 'JSON'] }
    expect((await session(created.id)).messages.at(-1)).toMatchObject(expected)
    expect(t.events.findLast(e => e.type === 'plan.message')).toMatchObject({ message: expected })
    // Recommendation alone works too
    expect(await runner.call(job.runId, job.leaseEpoch, 'ask_question', { question: 'Daily?', recommendation: 'Yes' })).toMatchObject({ ok: true })
    expect((await session(created.id)).messages.at(-1)).toMatchObject({ text: 'Daily?', recommendation: 'Yes', options: null })
    await endTurn(job, 'Over to you.')

    // The next turn's history numbers the options, so "2" can be matched
    await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: '2' })
    const next = (await runner.next('run.assign', m => m.job.planSessionId === created.id && m.job.runId !== job.runId)).job
    expect(next.fallbackPrompt).toContain('**PM (question):** Who uses exports?\n\n**')
    expect(next.fallbackPrompt).toContain('**PM (question):** Which format?\n\nOptions:\n1. CSV\n2. Excel\n3. JSON\n\nRecommended: CSV')
    expect(next.fallbackPrompt).toContain('**PM (question):** Daily?\n\nRecommended: Yes')
    await endTurn(next, 'Excel it is.')
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

  it('lets the PM comment on any task in its project, as the PM, and rejects other projects\' tasks', async () => {
    const project = await t.createProject()
    const other = await t.createProject()
    const task = await t.createTask(project.slug, { title: 'Add login' })
    const elsewhere = await t.createTask(other.slug, { title: 'Not ours' })

    await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: `Note on ${task.ref}` })
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job

    const before = t.events.length
    expect(await runner.call(job.runId, job.leaseEpoch, 'add_comment', { taskRef: task.ref, body: 'A follow-up task changes this' })).toMatchObject({ ok: true })
    const added = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/comments`).then(r => r.json()) as Comment[]
    expect(added).toMatchObject([{ body: 'A follow-up task changes this', pinned: false, author: { kind: 'agent', role: 'pm', runId: job.runId } }])
    expect(t.events.slice(before)).toContainEqual({ type: 'comment.created', comment: added[0] })

    const rejected = await runner.call(job.runId, job.leaseEpoch, 'add_comment', { taskRef: elsewhere.ref, body: 'Crossing over' })
    expect(rejected).toMatchObject({ ok: false, error: expect.stringContaining(`No task ${elsewhere.ref} in this project`) })
    expect(await t.request('GET', `/api/projects/${other.slug}/tasks/${elsewhere.number}/comments`).then(r => r.json())).toEqual([])
    await endTurn(job, 'Noted.')
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
        priority: 'urgent',
        humanReview: true,
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
    expect(before).toMatchObject({ title: 'Add login', status: 'backlog', priority: 'medium', humanReview: false, dependsOn: [base.ref], epicId: null })
    expect(before.acceptanceCriteria.map(c => [c.id, c.text])).toEqual(target.acceptanceCriteria.map(c => [c.id, c.text]))
    expect(richTextToMarkdown(before.description)).toBe('Email and password')

    // The plan shows the staged edits under the task's own ref
    const [v1] = (await session(created.id)).plans
    const rateLimiter = v1!.tasks[1]!.ref!
    expect(v1!.tasks).toMatchObject([
      { key: 't1', ref: target.ref, revises: true, title: 'Add email login', status: 'backlog', priority: 'urgent', humanReview: true, dependsOn: [other.ref, rateLimiter], epicId: null },
      { key: 't2', revises: false, title: 'Rate limiter', status: 'draft' }
    ])
    await endTurn(job, 'Proposed.')

    const approved = await t.request('POST', `/api/plan/plans/${v1!.id}/approve`, { to: 'backlog' })
    expect(approved.status).toBe(200)
    const after = await getTask(target.ref)
    expect(after).toMatchObject({ title: 'Add email login', status: 'backlog', priority: 'urgent', humanReview: true, dependsOn: [other.ref, rateLimiter], epicId: null })
    expect(v1!.epicId).toBeNull()
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

  it('rejects ref-shaped keys and resolves mixed-case dependencies to revised tasks', async () => {
    const { target, job, created } = await backlogSetup()
    const propose = (input: Parameters<typeof plan>[0]) => runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan(input))
    expect(await propose([{ key: target.ref }, { dependsOn: [target.ref] }]))
      .toMatchObject({ ok: false, error: expect.stringContaining('key_shaped_like_ref') })
    expect(await propose([{ key: target.ref.toLowerCase() }]))
      .toMatchObject({ ok: false, error: expect.stringContaining('looks like a task ref') })
    expect(await propose([{ ref: target.ref.toLowerCase(), dependsOn: ['t2'] }, { dependsOn: [target.ref.toLowerCase()] }]))
      .toMatchObject({ ok: false, error: expect.stringContaining('cycle') })
    const result = await propose([{ ref: target.ref.toLowerCase() }, { dependsOn: [target.ref.toLowerCase()] }])
    expect(result).toMatchObject({ ok: true, result: { tasks: [
      { key: 't1', ref: target.ref, revises: true },
      { key: 't2' }
    ] } })
    expect((await session(created.id)).plans.at(-1)!.tasks).toEqual(expect.arrayContaining([
      expect.objectContaining({ key: 't2', dependsOn: [target.ref] })
    ]))
    await endTurn(job, 'Dependencies checked.')
  })

  it('rejects a ref that is unknown, deleted, from another project or past the Backlog, saying why', async () => {
    const { project, target, job, count } = await backlogSetup()
    const deleted = await t.createTask(project.slug, { title: 'Old idea' })
    expect((await t.request('DELETE', `/api/projects/${project.slug}/tasks/${deleted.number}`)).status).toBe(204)
    const started = await t.createTask(project.slug, { title: 'Started' })
    await t.db.update(tasks).set({ status: 'in_progress' }).where(eq(tasks.id, started.id))
    const elsewhere = await t.createProject()
    const foreign = await t.createTask(elsewhere.slug, { title: 'Foreign' })
    const tasksBefore = await count()

    const propose = (ref: string) => runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ ref, title: 'Revised' }]))
    expect(await propose(`${project.prefix}-999`)).toMatchObject({ ok: false, error: expect.stringContaining(`There is no task ${project.prefix}-999 in this project`) })
    expect(await propose(deleted.ref)).toMatchObject({ ok: false, error: expect.stringContaining(`${deleted.ref} was deleted`) })
    expect(await propose(foreign.ref)).toMatchObject({ ok: false, error: expect.stringContaining(`${foreign.ref} belongs to the project`) })
    expect(await propose(started.ref)).toMatchObject({ ok: false, error: expect.stringContaining(`${started.ref} is in_progress; only Backlog and unclaimed Ready tasks can be revised`) })
    // A dependency may name any existing task, but not a deleted one
    expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ dependsOn: [deleted.ref] }]))).toMatchObject({ ok: false, error: expect.stringContaining('deleted_ref') })
    expect(await count()).toBe(tasksBefore)
    expect((await t.request('GET', `/api/tasks/${target.ref}`).then(r => r.json()) as Task).title).toBe('Add login')
    await endTurn(job, 'Nothing saved.')
  })

  const lease = (runId: string) => ({ leaseRunId: runId, leaseRole: 'developer' as const, leaseAcquiredAt: new Date(), leaseHeartbeatAt: new Date(), leaseExpiresAt: new Date(Date.now() + 60_000) })
  const noLease = { leaseRunId: null, leaseRole: null, leaseAcquiredAt: null, leaseHeartbeatAt: null, leaseExpiresAt: null }

  it('revises an unclaimed Ready task, which stays in Ready whichever way the plan is approved', async () => {
    for (const to of ['ready', 'backlog'] as const) {
      const { target, created, job, getTask, revise } = await backlogSetup()
      await t.db.update(tasks).set({ status: 'ready' }).where(eq(tasks.id, target.id))
      expect(await revise()).toMatchObject({ ok: true, result: { tasks: [{ ref: target.ref, revises: true }, { revises: false }] } })
      expect((await getTask(target.ref)).title).toBe('Add login')
      await endTurn(job, 'Revised.')
      const [plan] = (await session(created.id)).plans
      const approved = await t.request('POST', `/api/plan/plans/${plan!.id}/approve`, { to })
      expect(approved.status).toBe(200)
      expect(await getTask(target.ref)).toMatchObject({ title: 'Add email login', status: 'ready', priority: 'urgent' })
    }
  })

  it('rejects revising a Ready task with a lease or earlier runs, pointing at update_task', async () => {
    const { project, target, job, getTask } = await backlogSetup()
    const propose = (ref: string) => runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ ref, title: 'Revised' }]))
    // The run that picked it up has ended, and the task went back to Ready
    await t.db.update(tasks).set({ status: 'ready' }).where(eq(tasks.id, target.id))
    const [developer] = await t.db.select().from(agents).where(eq(agents.role, 'developer')).limit(1)
    await t.db.insert(runs).values({ agentId: developer!.id, projectId: project.id, taskId: target.id, role: 'developer', state: 'failed', endedAt: new Date(), leaseEpoch: 1, queuedAt: new Date() })
    const ran = await propose(target.ref)
    expect(ran).toMatchObject({ ok: false, error: expect.stringContaining(`${target.ref} has already been picked up`) })
    expect(ran).toMatchObject({ error: expect.stringContaining('update_task') })

    const leased = await t.createTask(project.slug, { title: 'Leased' })
    await t.db.update(tasks).set({ status: 'ready', ...lease(job.runId) }).where(eq(tasks.id, leased.id))
    expect(await propose(leased.ref)).toMatchObject({ ok: false, error: expect.stringContaining(`${leased.ref} has already been picked up`) })
    await t.db.update(tasks).set(noLease).where(eq(tasks.id, leased.id))
    expect((await getTask(target.ref)).title).toBe('Add login')
    await endTurn(job, 'Nothing saved.')
  })

  it('refuses approval with a problem naming a revised task claimed since, applying none of the plan', async () => {
    const claimed: ((task: Task, runId: string) => Promise<unknown>)[] = [
      (task, runId) => t.db.update(tasks).set({ status: 'in_progress', ...lease(runId) }).where(eq(tasks.id, task.id)),
      // Still Ready, but a run has it: the status alone doesn't show this
      (task, runId) => t.db.update(tasks).set({ status: 'ready', ...lease(runId) }).where(eq(tasks.id, task.id))
    ]
    for (const claim of claimed) {
      const { project, target, created, job, getTask, count, revise } = await backlogSetup()
      await t.db.update(tasks).set({ status: 'ready' }).where(eq(tasks.id, target.id))
      expect(await revise()).toMatchObject({ ok: true })
      await endTurn(job, 'Revised.')
      const [proposed] = (await session(created.id)).plans
      const rateLimiter = proposed!.tasks[1]!.ref!
      const before = await count()
      await claim(target, job.runId)

      const refused = await t.request('POST', `/api/plan/plans/${proposed!.id}/approve`, { to: 'ready' })
      expect(refused.status).toBe(409)
      expect(await refused.json()).toMatchObject({ error: { code: 'plan_not_approvable', problems: [{ code: 'ref_not_revisable', key: 't1', ref: target.ref, message: expect.stringContaining(target.ref) }] } })
      expect(await getTask(target.ref)).toMatchObject({ title: 'Add login', priority: 'medium' })
      expect(await getTask(rateLimiter)).toMatchObject({ status: 'draft' })
      expect(await count()).toBe(before)
      expect((await session(created.id)).plans[0]).toMatchObject({ status: 'proposed' })
      await t.db.update(tasks).set(noLease).where(eq(tasks.projectId, project.id))
    }
  })

  it('tells the PM which revised task stopped approve_plan', async () => {
    const { target, created, job, revise } = await backlogSetup()
    await t.db.update(tasks).set({ status: 'ready' }).where(eq(tasks.id, target.id))
    expect(await revise()).toMatchObject({ ok: true })
    await endTurn(job, 'Revised.')
    await t.db.update(tasks).set({ status: 'in_progress' }).where(eq(tasks.id, target.id))
    expect((await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'Looks good, add it to the board' })).status).toBeLessThan(300)
    const next = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.planSessionId === created.id)).job
    expect(await runner.call(next.runId, next.leaseEpoch, 'approve_plan', { to: 'ready' })).toMatchObject({ ok: false, error: expect.stringContaining(`${target.ref} is in_progress`) })
    await endTurn(next, 'Not approved.')
  })

  it('tells the PM a revised Ready task stayed on the board', async () => {
    const { target, created, job, revise } = await backlogSetup()
    await t.db.update(tasks).set({ status: 'ready' }).where(eq(tasks.id, target.id))
    expect(await revise()).toMatchObject({ ok: true })
    await endTurn(job, 'Revised.')
    expect((await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'Looks good, add it to the backlog' })).status).toBeLessThan(300)
    const next = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.planSessionId === created.id)).job
    expect(await runner.call(next.runId, next.leaseEpoch, 'approve_plan', { to: 'backlog' })).toMatchObject({ ok: true, result: { message: expect.stringContaining('1 task in the Backlog, 1 on the board') } })
    await endTurn(next, 'Approved.')
  })

  it('revises a task an approved version of the same session put on the board', async () => {
    const { project, job, created, getTask } = await backlogSetup()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ title: 'First cut' }]))).toMatchObject({ ok: true })
    await endTurn(job, 'Proposed.')
    const [first] = (await session(created.id)).plans
    expect((await t.request('POST', `/api/plan/plans/${first!.id}/approve`, { to: 'ready' })).status).toBe(200)
    const ref = first!.tasks[0]!.ref!
    expect((await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'Rename it' })).status).toBeLessThan(300)
    const next = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.planSessionId === created.id)).job
    expect(await runner.call(next.runId, next.leaseEpoch, 'propose_plan', plan([{ ref, title: 'Second cut' }]))).toMatchObject({ ok: true, result: { tasks: [{ ref, revises: true }] } })
    await endTurn(next, 'Revised.')
    const latest = (await session(created.id)).plans.at(-1)!
    expect((await t.request('POST', `/api/plan/plans/${latest.id}/approve`, { to: 'ready' })).status).toBe(200)
    expect(await getTask(ref)).toMatchObject({ title: 'Second cut', status: 'ready' })
  })

  it('spans several epics, keeping each one a revision still names and deleting the one it drops', async () => {
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan accounts' }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    const epicsIn = [{ key: 'e1', title: 'Login' }, { key: 'e2', title: 'Billing' }, { key: 'e3', title: 'Audit' }]

    // A task can only name an epic the plan gives
    const unknown = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', { ...plan([]), epics: epicsIn.slice(0, 1), tasks: plan([{}, {}]).tasks.map((x, i) => ({ ...x, epic: i === 0 ? 'e1' : 'e9' })) })
    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining('unknown_epic') })
    expect(await t.db.select().from(tasks).where(eq(tasks.projectId, project.id))).toEqual([])

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
        { key: 't1', epic: 'e2', title: 'Login form', description: 'Build it', type: 'task', acceptanceCriteria: ['It works'] },
        { key: 't2', epic: 'e2', title: 'Invoices', description: 'Build it', type: 'task', acceptanceCriteria: ['It works'], dependsOn: ['t1'] },
        { key: 't4', epic: 'e1', title: 'Logout', description: 'Build it', type: 'task', acceptanceCriteria: ['It works'] }
      ]
    })
    expect(v2).toMatchObject({ ok: true, result: { tasks: [{ key: 't1', change: 'changed' }, { key: 't2', change: 'unchanged' }, { key: 't4', change: 'added' }, { key: 't3', change: 'removed' }] } })
    const second = (await session(created.id)).plans[1]!
    expect(second.epics.map(e => [e.key, e.id, e.title])).toEqual([['e1', first.epics[0]!.id, 'Login'], ['e2', first.epics[1]!.id, 'Payments']])
    expect(second.tasks.filter(x => x.ref).map(x => x.epicId)).toEqual([first.epics[1]!.id, first.epics[1]!.id, first.epics[0]!.id])
    expect(await t.db.select().from(epics).where(eq(epics.id, first.epics[2]!.id))).toEqual([])
    await endTurn(job, 'Proposed.')
  })

  it('gives a task that leaves out epic no epic, even when the plan has epics', async () => {
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan login' }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    const proposed = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', {
      ...plan([]),
      epics: [{ key: 'e1', title: 'Login' }],
      tasks: [
        { key: 't1', epic: 'e1', title: 'Login form', description: 'Build it', type: 'task', acceptanceCriteria: ['It works'] },
        { key: 't2', title: 'Fix typo', description: 'Fix it', type: 'bug', acceptanceCriteria: ['It is spelt right'] }
      ]
    })
    expect(proposed).toMatchObject({ ok: true })
    const [v1] = (await session(created.id)).plans
    expect(v1!.epics.map(e => e.title)).toEqual(['Login'])
    expect(v1!.epicId).toBe(v1!.epics[0]!.id)
    expect(v1!.tasks.map(x => [x.title, x.epicId])).toEqual([['Login form', v1!.epics[0]!.id], ['Fix typo', null]])
    const rows = await t.db.select().from(tasks).where(eq(tasks.projectId, project.id)).orderBy(tasks.number)
    expect(rows.map(r => [r.title, r.epicId])).toEqual([['Login form', v1!.epics[0]!.id], ['Fix typo', null]])
    expect(await t.db.select().from(epics).where(eq(epics.projectId, project.id))).toHaveLength(1)
    await endTurn(job, 'Proposed.')
  })

  it('refuses locked epic mode changes in reopened approved plans without saving the revision (D27)', async () => {
    const evidence: unknown[] = []
    async function request(method: string, path: string, body?: unknown) {
      const response = await fetch(`${t.server!.url}${path}`, {
        method,
        ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
      })
      const result: unknown = await response.json()
      evidence.push({ request: { method, path, body }, response: { status: response.status, body: result } })
      expect(response.ok).toBe(true)
      return result
    }
    const project = await t.createProject({ repository: 'cormacrw/test-app' })
    await request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    const created = await request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan login in an epic' }) as PlanSessionDetail
    let job = (await runner.next('run.assign', m => m.job.planSessionId === created.id)).job
    async function propose(reviewMode?: string, title = 'Login') {
      const input = {
        ...plan([]),
        epics: [{ key: 'login', title, ...(reviewMode && { reviewMode }) }],
        tasks: [{ ...plan([{}]).tasks[0]!, epic: 'login' }]
      }
      const response = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', input)
      evidence.push({ request: { transport: 'runner WebSocket', tool: 'propose_plan', input }, response })
      return response
    }
    expect(await propose('each_task')).toMatchObject({ ok: true })
    // A Draft revision with no PR work can still change the mode.
    expect(await propose('epic')).toMatchObject({ ok: true })
    const draft = await request('GET', `/api/plan/sessions/${created.id}`) as PlanSessionDetail
    const latest = draft.plans.at(-1)!
    const epicId = latest.epics[0]!.id
    expect(latest).toMatchObject({ status: 'proposed', epics: [{ reviewMode: 'epic' }], tasks: [{ status: 'draft' }] })
    await endTurn(job, 'Ready for approval.')
    const approved = await request('POST', `/api/plan/plans/${latest.id}/approve`) as Plan
    expect(approved).toMatchObject({ status: 'approved', tasks: [{ status: 'ready' }] })
    await t.db.update(tasks).set({ status: 'merged' }).where(eq(tasks.id, approved.tasks[0]!.taskId!))
    await request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'Revisit the plan' })
    job = (await runner.next('run.assign', m => m.job.planSessionId === created.id)).job
    const before = await request('GET', `/api/plan/sessions/${created.id}`) as PlanSessionDetail
    for (const mode of ['direct', 'each_task']) {
      expect(await propose(mode, 'Must roll back')).toMatchObject({ ok: false, error: expect.stringContaining('The plan was not saved: the review mode can\'t change') })
      expect((await request('GET', `/api/plan/sessions/${created.id}`) as PlanSessionDetail).plans).toEqual(before.plans)
      expect(await request('GET', `/api/epics/${epicId}`)).toMatchObject({ reviewMode: 'epic', title: 'Login', tasks: [{ status: 'merged' }] })
    }
    // The mode itself, not the fact of revising a live epic, is locked.
    expect(await propose('epic', 'Allowed metadata')).toMatchObject({ ok: true })
    expect(await propose(undefined, 'Mode omitted')).toMatchObject({ ok: true })
    expect(await request('GET', `/api/epics/${epicId}`)).toMatchObject({ reviewMode: 'epic', title: 'Mode omitted', tasks: [{ status: 'merged' }] })
    const after = await request('GET', `/api/plan/sessions/${created.id}`) as PlanSessionDetail
    expect(after.plans).toHaveLength(before.plans.length + 2)
    expect(after.plans.at(-1)).toMatchObject({ status: 'proposed', epics: [{ reviewMode: 'epic' }] })
    await endTurn(job, 'Kept the epic review mode.')
    if (process.env.CORRAL_PLAN_MODE_EVIDENCE) await writeFile(process.env.CORRAL_PLAN_MODE_EVIDENCE, JSON.stringify(evidence, null, 2))
  })

  it('stores each epic\'s review mode from the plan or the project\'s default, and rejects an unknown one (D27)', async () => {
    const project = await t.createProject()
    expect(project.epicReviewModeDefault).toBe('epic')
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan login' }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    const propose = (epicsIn: object[]) => runner.call(job.runId, job.leaseEpoch, 'propose_plan', {
      ...plan([]),
      epics: epicsIn,
      tasks: epicsIn.map((_, i) => ({ key: `t${i + 1}`, epic: `e${i + 1}`, title: `Task ${i + 1}`, description: 'Build it', type: 'task', acceptanceCriteria: ['It works'] }))
    })

    const bad = await propose([{ key: 'e1', title: 'Login', reviewMode: 'later' }])
    expect(bad).toMatchObject({ ok: false, error: expect.stringContaining('reviewMode must be one of epic, each_task, direct') })
    expect(await t.db.select().from(epics).where(eq(epics.projectId, project.id))).toEqual([])

    expect(await propose([{ key: 'e1', title: 'Login' }, { key: 'e2', title: 'Logout', reviewMode: 'each_task' }])).toMatchObject({ ok: true })
    const [v1] = (await session(created.id)).plans
    expect(v1!.epics.map(e => [e.title, e.reviewMode])).toEqual([['Login', 'epic'], ['Logout', 'each_task']])

    // The next new epic takes the changed default; a revision that leaves
    // the mode out keeps each existing epic's
    expect((await t.request('PATCH', `/api/projects/${project.slug}`, { epicReviewModeDefault: 'direct' })).status).toBe(200)
    expect(await propose([{ key: 'e1', title: 'Login' }, { key: 'e2', title: 'Logout' }, { key: 'e3', title: 'Reset' }])).toMatchObject({ ok: true })
    const v2 = (await session(created.id)).plans[1]!
    expect(v2.epics.map(e => [e.title, e.reviewMode])).toEqual([['Login', 'epic'], ['Logout', 'each_task'], ['Reset', 'direct']])

    const approved = await t.request('POST', `/api/plan/plans/${v2.id}/approve`, { to: 'backlog' })
    expect(approved.status).toBe(200)
    const epic = await t.request('GET', `/api/epics/${v2.epics[1]!.id}`).then(r => r.json()) as EpicDetail
    expect(epic).toMatchObject({ reviewMode: 'each_task', branch: null, prNumber: null, prHeadSha: null, reviewState: null })
    await endTurn(job, 'Proposed.')
  })

  it('accepts task, bug, spike and design in propose_plan and rejects the old area types (D19, D20)', async () => {
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan login' })
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    for (const type of ['frontend', 'backend', 'full_stack', 'infrastructure']) {
      expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ type }]))).toMatchObject({ ok: false })
    }
    expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ type: 'task' }, { type: 'bug' }, { type: 'spike' }, { type: 'design' }]))).toMatchObject({ ok: true })
    const rows = await t.db.select().from(tasks).where(eq(tasks.projectId, project.id)).orderBy(tasks.number)
    expect(rows.map(r => r.type)).toEqual(['task', 'bug', 'spike', 'design'])
    await endTurn(job, 'Proposed.')
  })

  it('gives a design task human review even when the plan sets it false (D20)', async () => {
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Design login' }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    const proposed = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ type: 'design', humanReview: false }, { type: 'task', humanReview: false }]))
    expect(proposed).toMatchObject({ ok: true })
    await endTurn(job, 'Proposed.')
    const [v1] = (await session(created.id)).plans
    expect(await t.request('POST', `/api/plan/plans/${v1!.id}/approve`, { to: 'backlog' }).then(r => r.status)).toBe(200)
    const rows = await t.db.select().from(tasks).where(eq(tasks.projectId, project.id)).orderBy(tasks.number)
    expect(rows.map(r => [r.type, r.humanReview])).toEqual([['design', true], ['task', false]])
  })

  it('gives a Backlog task revised into a design task human review (D20)', async () => {
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const target = await t.createTask(project.slug, { title: 'Login page', humanReview: false })
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: `Design ${target.ref}` }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.planSessionId === created.id)).job
    expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ ref: target.ref, type: 'design', humanReview: false }]))).toMatchObject({ ok: true })
    await endTurn(job, 'Proposed.')
    const [v1] = (await session(created.id)).plans
    expect(await t.request('POST', `/api/plan/plans/${v1!.id}/approve`, { to: 'backlog' }).then(r => r.status)).toBe(200)
    const after = await t.request('GET', `/api/tasks/${target.ref}`).then(r => r.json()) as Task
    expect(after).toMatchObject({ type: 'design', humanReview: true })
  })

  // A design task with v1 superseded, v2 approved and v3 submitted (D20)
  async function designSetup() {
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const design = await t.createTask(project.slug, { title: 'Login design', type: 'design' })
    const spec = await t.blobs.put(Buffer.from('# Login\n\n## Screens\n- `login`\n- `login-error`\n'))
    const bundle = await t.blobs.put(Buffer.from('bundle-bytes'))
    const shot = await t.blobs.put(Buffer.from('png-bytes'))
    for (const [version, status] of [[1, 'superseded'], [2, 'approved'], [3, 'submitted']] as const) {
      await t.db.insert(schema.designVersions).values({
        taskId: design.id, version, status, specBlob: spec, bundleBlob: bundle, branch: `design/${design.ref}`, commitSha: `sha${version}`,
        screenshots: [{ blob: shot, fileName: 'login.png', contentType: 'image/png' }]
      })
    }
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: `Plan the build of ${design.ref}` }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.planSessionId === created.id)).job
    const getTask = (ref: string) => t.request('GET', `/api/tasks/${ref}`).then(r => r.json()) as Promise<Task>
    return { project, design, created, job, getTask, blobs: { spec, bundle, shot } }
  }

  it('gives the PM a design version with get_design: the latest by default, a given version, or a pinned task\'s version (D20)', async () => {
    const { design, created, job } = await designSetup()
    const latest = await runner.call(job.runId, job.leaseEpoch, 'get_design', { taskRef: design.ref.toLowerCase() })
    expect(latest).toMatchObject({
      ok: true,
      result: {
        taskRef: design.ref, title: 'Login design', version: 3, status: 'submitted', branch: `design/${design.ref}`, commitSha: 'sha3', pinnedScreens: null,
        spec: expect.stringContaining('`login-error`'),
        screenshots: [{ fileName: 'login.png', contentType: 'image/png', dataBase64: Buffer.from('png-bytes').toString('base64') }],
        bundle: { dataBase64: Buffer.from('bundle-bytes').toString('base64') }
      }
    })
    expect(await runner.call(job.runId, job.leaseEpoch, 'get_design', { taskRef: design.ref, version: 2 })).toMatchObject({ ok: true, result: { version: 2, status: 'approved', commitSha: 'sha2' } })
    expect(await runner.call(job.runId, job.leaseEpoch, 'get_design', { taskRef: design.ref, version: 9 })).toMatchObject({ ok: false, error: `${design.ref} has no design version v9` })

    // A build task pinned to v2 reads v2 and its screens
    expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ title: 'Login form', design: { taskRef: design.ref, version: 2, screens: ['login'] } }]))).toMatchObject({ ok: true })
    const [v1] = (await session(created.id)).plans
    expect(await runner.call(job.runId, job.leaseEpoch, 'get_design', { taskRef: v1!.tasks[0]!.ref })).toMatchObject({ ok: true, result: { taskRef: design.ref, version: 2, pinnedScreens: ['login'] } })
    expect(await runner.call(job.runId, job.leaseEpoch, 'get_design', { taskRef: 'NOPE-1' })).toMatchObject({ ok: false, error: expect.stringContaining('No task NOPE-1') })
    await endTurn(job, 'Read it.')
  })

  it('keeps a task\'s design pin from proposal through approval and shows it on the task (D20)', async () => {
    const { design, created, job, getTask } = await designSetup()
    const pin = { taskRef: design.ref.toLowerCase(), version: 2, screens: ['login', 'login-error'] }
    expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ title: 'Login form', design: pin }, { title: 'API' }]))).toMatchObject({ ok: true })
    const [v1] = (await session(created.id)).plans
    const [form, api] = v1!.tasks
    expect((await getTask(form!.ref!)).design).toEqual({ taskRef: design.ref, version: 2, screens: ['login', 'login-error'], newerVersion: null })
    expect((await getTask(api!.ref!)).design).toBeNull()

    // An unchanged revision keeps the pin and counts the task as unchanged
    const again = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ title: 'Login form', design: pin }, { title: 'API' }]))
    expect(again).toMatchObject({ ok: true, result: { version: 2, tasks: [{ key: 't1', change: 'unchanged' }, { key: 't2', change: 'unchanged' }] } })
    const [, v2] = (await session(created.id)).plans
    await endTurn(job, 'Proposed.')

    expect(await t.request('POST', `/api/plan/plans/${v2!.id}/approve`, { to: 'ready' }).then(r => r.status)).toBe(200)
    expect(await getTask(form!.ref!)).toMatchObject({ status: 'ready', design: { taskRef: design.ref, version: 2, screens: ['login', 'login-error'] } })
  })

  it('rejects a pin to a design version that isn\'t approved, doesn\'t exist or isn\'t a design, and lists the screens a pin needs (D20)', async () => {
    const { project, design, job } = await designSetup()
    const other = await t.createTask(project.slug, { title: 'Not a design' })
    const count = async () => (await t.db.select().from(tasks).where(eq(tasks.projectId, project.id))).length
    const before = await count()
    const propose = (pin: { taskRef: string, version: number, screens: string[] }) => runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ design: pin }]))
    expect(await propose({ taskRef: design.ref, version: 1, screens: ['login'] })).toMatchObject({ ok: false, error: expect.stringContaining(`Design ${design.ref} v1 is superseded; pin only the approved version.`) })
    expect(await propose({ taskRef: design.ref, version: 3, screens: ['login'] })).toMatchObject({ ok: false, error: expect.stringContaining('design_not_approved') })
    expect(await propose({ taskRef: design.ref, version: 7, screens: ['login'] })).toMatchObject({ ok: false, error: expect.stringContaining('design_not_found') })
    expect(await propose({ taskRef: other.ref, version: 1, screens: ['login'] })).toMatchObject({ ok: false, error: expect.stringContaining('isn\'t a design task') })
    expect(await propose({ taskRef: 'XYZ-1', version: 1, screens: ['login'] })).toMatchObject({ ok: false, error: expect.stringContaining('design_not_found') })
    expect(await propose({ taskRef: design.ref, version: 2, screens: [] })).toMatchObject({ ok: false, error: expect.stringContaining('design_without_screens') })
    // Nothing was saved
    expect(await count()).toBe(before)
    await endTurn(job, 'Could not plan.')
  })

  it('stages a pin on a revised Backlog task and writes it on approval (D20)', async () => {
    const { project, design, job, created, getTask } = await designSetup()
    await endTurn(job, 'Hi.')
    const target = await t.createTask(project.slug, { title: 'Login form' })
    await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: `Pin ${target.ref}` })
    const next = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.planSessionId === created.id && m.job.runId !== job.runId)).job
    expect(await runner.call(next.runId, next.leaseEpoch, 'propose_plan', plan([{ ref: target.ref, title: 'Login form', design: { taskRef: design.ref, version: 2, screens: ['login'] } }]))).toMatchObject({ ok: true })
    // Staged, not yet written
    expect((await getTask(target.ref)).design).toBeNull()
    await endTurn(next, 'Proposed.')
    const [v1] = (await session(created.id)).plans
    expect(await t.request('POST', `/api/plan/plans/${v1!.id}/approve`, { to: 'backlog' }).then(r => r.status)).toBe(200)
    expect((await getTask(target.ref)).design).toEqual({ taskRef: design.ref, version: 2, screens: ['login'], newerVersion: null })
  })

  it('creates flag_stale_docs tasks with type task', async () => {
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'The wiki is out of date' })
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    const flagged = await runner.call(job.runId, job.leaseEpoch, 'flag_stale_docs', { title: 'Update the wiki', description: 'The runner page is stale' })
    expect(flagged).toMatchObject({ ok: true })
    const rows = await t.db.select().from(tasks).where(eq(tasks.projectId, project.id))
    expect(rows.map(r => [r.title, r.type])).toEqual([['Update the wiki', 'task']])
    await endTurn(job, 'Flagged.')
  })

  it('takes a Backlog task out of its epic when a revision by ref leaves out epic', async () => {
    const { project, target, job, getTask, revise } = await backlogSetup()
    const [epic] = await t.db.insert(epics).values({ projectId: project.id, title: 'Accounts', createdBy: t.actor }).returning()
    await t.db.update(tasks).set({ epicId: epic!.id }).where(eq(tasks.id, target.id))
    expect(await revise()).toMatchObject({ ok: true })
    await endTurn(job, 'Proposed.')
    const plans = (await session(job.planSessionId!)).plans
    expect(plans[0]!.tasks[0]).toMatchObject({ ref: target.ref, revises: true, epicId: null })
    // Staged only: the task keeps its epic until approval
    expect((await getTask(target.ref)).epicId).toBe(epic!.id)
    expect((await t.request('POST', `/api/plan/plans/${plans[0]!.id}/approve`, { to: 'backlog' })).status).toBe(200)
    expect(await getTask(target.ref)).toMatchObject({ title: 'Add email login', epicId: null })
  })

  // Plans saved before plan_epics, or with the implicit epic named after the
  // plan, have only plans.epicId
  async function oldPlanSetup() {
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan login' }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ title: 'Login form' }, { title: 'Logout' }]))).toMatchObject({ ok: true })
    const [v1] = (await session(created.id)).plans
    const [epic] = await t.db.insert(epics).values({ projectId: project.id, title: 'Login', createdBy: t.actor }).returning()
    await t.db.update(schema.plans).set({ epicId: epic!.id }).where(eq(schema.plans.id, v1!.id))
    await t.db.update(tasks).set({ epicId: epic!.id }).where(eq(tasks.projectId, project.id))
    return { project, created, job, epic: epic! }
  }

  it('still loads a plan that stored only plans.epicId, and keeps its epic when a revision names one', async () => {
    const { created, job, epic } = await oldPlanSetup()
    const [v1] = (await session(created.id)).plans
    expect(v1).toMatchObject({ epicId: epic.id, epics: [{ key: 'main', id: epic.id, title: 'Login' }] })
    expect(v1!.tasks.map(x => x.epicId)).toEqual([epic.id, epic.id])

    // A lone epic under a new key is the same epic, so the tasks are unchanged
    const v2 = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', {
      ...plan([]),
      epics: [{ key: 'e1', title: 'Sign in' }],
      tasks: plan([{ title: 'Login form' }, { title: 'Logout' }]).tasks.map(x => ({ ...x, epic: 'e1' }))
    })
    expect(v2).toMatchObject({ ok: true, result: { tasks: [{ key: 't1', change: 'unchanged' }, { key: 't2', change: 'unchanged' }] } })
    const second = (await session(created.id)).plans[1]!
    expect(second.epics).toEqual([{ key: 'e1', id: epic.id, title: 'Sign in', reviewMode: 'epic', dependsOn: [] }])
    expect(second.tasks.map(x => x.epicId)).toEqual([epic.id, epic.id])
    await endTurn(job, 'Proposed.')
  })

  it('takes an old plan\'s tasks out of its implicit epic, and deletes it, when a revision leaves out epics', async () => {
    const { project, created, job, epic } = await oldPlanSetup()
    const v2 = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ title: 'Login form' }, { title: 'Logout' }]))
    expect(v2).toMatchObject({ ok: true, result: { tasks: [{ key: 't1', change: 'changed' }, { key: 't2', change: 'changed' }] } })
    const second = (await session(created.id)).plans[1]!
    expect(second).toMatchObject({ epicId: null, epics: [] })
    expect(second.tasks.map(x => x.epicId)).toEqual([null, null])
    expect((await t.db.select().from(tasks).where(eq(tasks.projectId, project.id))).map(r => r.epicId)).toEqual([null, null])
    expect(await t.db.select().from(epics).where(eq(epics.id, epic.id))).toEqual([])
    await endTurn(job, 'Proposed.')
  })

  it('shows an epic with its tasks, Drafts included, and saves edits to it', async () => {
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan export' }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    const exports = plan([{ title: 'CSV export' }, { key: 't2', title: 'Export button', dependsOn: ['t1'] }])
    expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', { ...exports, epics: [{ key: 'e1', title: 'Login' }], tasks: exports.tasks.map(x => ({ ...x, epic: 'e1' })) })).toMatchObject({ ok: true })
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
    const afterApproval = await session(created.id)
    expect(afterApproval.plans[0]).toMatchObject({ status: 'approved', tasks: [{ status: 'backlog' }] })
    // Approving through the PM closes the session too
    expect(afterApproval.closed).toBe(true)
    const [closedRow] = await t.db.select().from(schema.planSessions).where(eq(schema.planSessions.id, created.id))
    expect(closedRow!.closedAt).toBeInstanceOf(Date)
    const [audit] = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'plan.approved')).orderBy(desc(schema.auditLog.id)).limit(1)
    expect(audit).toMatchObject({ actor: t.actor, detail: { to: 'backlog', viaPmRun: second.runId } })
    // Once approved there's nothing left to approve
    expect(await runner.call(second.runId, second.leaseEpoch, 'approve_plan', { to: 'ready' })).toMatchObject({ ok: false, error: expect.stringContaining('no plan waiting') })
    await endTurn(second, 'Added.')
  })

  it('marks a finished PM turn unread, closes the session on approving to the Backlog, and reopens it on a new message', async () => {
    const project = await t.createProject()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan search' }).then(r => r.json()) as PlanSessionDetail
    expect(created).toMatchObject({ unread: false, closed: false })
    const job = (await runner.next('run.assign', m => m.job.planSessionId === created.id)).job
    expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ title: 'Search box' }]))).toMatchObject({ ok: true })
    const before = t.events.length
    await endTurn(job, 'Proposed.')

    // The finished turn is unread, and the session event says so
    expect(t.events.slice(before).findLast(e => e.type === 'plan.session' && e.session.id === created.id)).toMatchObject({ session: { unread: true, activeRunId: null } })
    expect((await t.request('GET', '/api/plan/sessions').then(r => r.json()) as PlanSession[]).find(s => s.id === created.id)).toMatchObject({ unread: true, closed: false })
    // Opening it clears it
    expect(await t.request('POST', `/api/plan/sessions/${created.id}/read`).then(r => r.json())).toMatchObject({ unread: false })
    expect((await session(created.id)).unread).toBe(false)

    // Add to Backlog closes the session
    const planId = (await session(created.id)).plans[0]!.id
    const approving = t.events.length
    expect((await t.request('POST', `/api/plan/plans/${planId}/approve`, { to: 'backlog' })).status).toBe(200)
    expect(await session(created.id)).toMatchObject({ closed: true, plans: [{ status: 'approved', tasks: [{ status: 'backlog' }] }] })
    expect(t.events.slice(approving).findLast(e => e.type === 'plan.session' && e.session.id === created.id)).toMatchObject({ session: { closed: true } })
    const [row] = await t.db.select().from(schema.planSessions).where(eq(schema.planSessions.id, created.id))
    const [approvedRow] = await t.db.select().from(schema.plans).where(eq(schema.plans.id, planId))
    expect(row!.closedAt).toEqual(approvedRow!.approvedAt)

    // A new human message reopens it
    const reopening = t.events.length
    expect((await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'One more thing' })).status).toBe(201)
    expect(await session(created.id)).toMatchObject({ closed: false, unread: false })
    expect(t.events.slice(reopening).findLast(e => e.type === 'plan.session' && e.session.id === created.id)).toMatchObject({ session: { closed: false } })
    const next = (await runner.next('run.assign', m => m.job.planSessionId === created.id && m.job.runId !== job.runId)).job
    await endTurn(next, 'Noted.')
    expect(await session(created.id)).toMatchObject({ closed: false, unread: true })
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
    await t.db.update(agents).set({ name: 'Renamed PM' }).where(eq(agents.id, pm!.id))
    try {
      const project = await t.createProject()
      const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Hello' }).then(r => r.json()) as PlanSessionDetail
      const first = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
      const resetsAt = '2030-01-01T00:00:00.000Z'
      runner.send({ type: 'run.ended', runId: first.runId, leaseEpoch: first.leaseEpoch, exit: { kind: 'rate_limited', resetsAt }, headSha: null })
      await sleep(150)
      expect((await session(created.id)).messages.at(-1)).toMatchObject({ role: 'pm', kind: 'error', text: `Renamed PM hit a usage limit; try again after ${resetsAt}` })

      await t.db.update(agents).set({ pausedUntil: null }).where(eq(agents.id, pm!.id))
      await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'Again' })
      const second = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.planSessionId === created.id)).job
      runner.send({ type: 'run.ended', runId: second.runId, leaseEpoch: second.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
      await sleep(150)
      expect((await session(created.id)).messages.at(-1)).toMatchObject({ role: 'pm', kind: 'error', text: 'Renamed PM finished without replying' })
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

  it('starts every session\'s turn at once, whatever the PM\'s concurrency in the DB', async () => {
    // The column is ignored for the PM (D13): only one turn per session limits it
    await t.db.update(agents).set({ concurrency: 1 }).where(eq(agents.role, 'pm'))
    const projectA = await t.createProject()
    const projectB = await t.createProject()
    const sessions: PlanSessionDetail[] = []
    for (const [project, text] of [[projectA, 'Plan search'], [projectA, 'Plan billing'], [projectB, 'Plan audit']] as const) {
      const res = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text })
      expect(res.status).toBe(201)
      sessions.push(await res.json() as PlanSessionDetail)
    }
    const jobs = await Promise.all(sessions.map(s => runner.next('run.assign', m => m.job.planSessionId === s.id).then(m => m.job)))
    // All three were sent to the runner, none held back, and all run together
    const sent = await t.db.select().from(runs).where(inArray(runs.id, jobs.map(j => j.runId)))
    expect(sent.map(r => r.pmJob)).toEqual([null, null, null])
    for (const job of jobs) runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: `claude-${job.runId}` })
    await vi.waitFor(async () => {
      const rows = await t.db.select().from(runs).where(inArray(runs.id, jobs.map(j => j.runId)))
      expect(rows.map(r => r.state)).toEqual(['running', 'running', 'running'])
    })

    // Still one turn at a time per session
    const again = await t.request('POST', `/api/plan/sessions/${sessions[1]!.id}/messages`, { text: 'Again' })
    expect(again.status).toBe(409)
    expect(await again.json()).toMatchObject({ error: { code: 'conflict', constraint: 'pm_turn_in_progress' } })

    for (const job of jobs) await endTurn(job, 'Noted.')
    for (const s of sessions) expect((await session(s.id)).activeRunId).toBeNull()
    await t.db.update(agents).set({ concurrency: 50 }).where(eq(agents.role, 'pm'))
  })

  it('holds queued turns while the PM is paused, and sends them all when it resumes or on the next start pass', async () => {
    await t.db.update(agents).set({ concurrency: 1 }).where(eq(agents.role, 'pm'))
    const [pm] = await t.db.select().from(agents).where(eq(agents.role, 'pm'))
    const project = await t.createProject()
    // Turns left `queued` with their jobs, as a restart or a pause leaves them
    const queue = async (count: number) => {
      const ids: string[] = []
      for (let i = 0; i < count; i++) {
        const [s] = await t.db.insert(schema.planSessions).values({ projectId: project.id, title: `Queued ${i}`, runtime: 'claude-code', createdBy: t.actor }).returning()
        const job = {
          role: 'pm', projectId: project.id, repository: project.repository, defaultBranch: project.defaultBranch, taskId: null, taskRef: null, branch: null, headSha: null,
          planSessionId: s!.id, agentSessionId: null, runtime: 'claude-code', model: null, timeoutSeconds: 600, prompt: `Queued ${i}`
        }
        const [run] = await t.db.insert(runs).values({ agentId: pm!.id, projectId: project.id, taskId: null, role: 'pm', leaseEpoch: 1, planSessionId: s!.id, pmJob: job as never, queuedAt: new Date() }).returning()
        ids.push(run!.id)
      }
      return ids
    }
    const assigned = (ids: string[]) => runner.received.filter(m => m.type === 'run.assign' && ids.includes(m.job.runId))

    // Paused: a start pass leaves them queued
    expect((await t.request('PATCH', `/api/agents/${pm!.id}`, { paused: true })).status).toBe(200)
    const paused = await queue(3)
    await t.orchestrator.schedule()
    await sleep(150)
    expect(assigned(paused)).toHaveLength(0)
    const held = await t.db.select().from(runs).where(inArray(runs.id, paused))
    expect(held.map(r => r.state)).toEqual(['queued', 'queued', 'queued'])

    // Resumed: all three go to the runner at once
    expect((await t.request('PATCH', `/api/agents/${pm!.id}`, { paused: false })).status).toBe(200)
    const resumedJobs = await Promise.all(paused.map(id => runner.next('run.assign', m => m.job.runId === id).then(m => m.job)))
    expect(resumedJobs.map(j => j.runId).sort()).toEqual([...paused].sort())

    // Queued when the server starts: the next start pass sends them all
    const atStart = await queue(3)
    await t.orchestrator.schedule()
    const startJobs = await Promise.all(atStart.map(id => runner.next('run.assign', m => m.job.runId === id).then(m => m.job)))
    expect(startJobs).toHaveLength(3)
    for (const job of startJobs) runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: `claude-${job.runId}` })
    await expect.poll(async () => {
      const started = await t.db.select().from(runs).where(inArray(runs.id, atStart))
      return started.map(r => [r.state, r.pmJob])
    }).toEqual([['running', null], ['running', null], ['running', null]])

    for (const job of [...resumedJobs, ...startJobs]) await endTurn(job, 'Noted.')
    await t.db.update(agents).set({ concurrency: 50 }).where(eq(agents.role, 'pm'))
  })

  it('leaves the plan session alone when the last task of an epic merges', async () => {
    const project = await t.createProject()
    await t.request('PATCH', `/api/projects/${project.slug}`, { requiredChecks: ['lint'] })
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Ship it' }).then(r => r.json()) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.projectId === project.id)).job
    await runner.call(job.runId, job.leaseEpoch, 'propose_plan', { ...plan([]), epics: [{ key: 'e1', title: 'Ship' }], tasks: plan([{ title: 'Only task' }]).tasks.map(x => ({ ...x, epic: 'e1' })) })
    await endTurn(job, 'Proposed.')
    const planId = (await session(created.id)).plans[0]!.id
    await t.request('POST', `/api/plan/sessions/${created.id}/read`)
    await t.request('POST', `/api/plan/plans/${planId}/approve`)

    // Developer and reviewer runs, then the merge
    await t.orchestrator.schedule()
    const dev = (await runner.next('run.assign', m => m.job.role === 'developer' && m.job.projectId === project.id)).job
    const task = await t.request('GET', `/api/tasks/${dev.taskRef}`).then(r => r.json()) as Task
    t.github.setBranch(project.repository, dev.branch!, 'abc123')
    await runner.call(dev.runId, dev.leaseEpoch, 'attach_evidence', { criterionId: task.acceptanceCriteria[0]!.id, kind: 'text', fileName: 'n.txt', contentType: 'text/plain', dataBase64: Buffer.from('x').toString('base64') })
    await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', note: 'Did the work', summary: 'Done', headSha: 'abc123' })
    await t.orchestrator.schedule()
    const review = (await runner.next('run.assign', m => m.job.role === 'reviewer' && m.job.taskId === task.id)).job
    await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Good', criteria: [{ criterionId: task.acceptanceCriteria[0]!.id, met: true, note: '' }] })
    t.github.setChecks('abc123', [{ name: 'lint', conclusion: 'success', url: null }])
    await t.mergePass()
    expect((await t.request('GET', `/api/tasks/${dev.taskRef}`).then(r => r.json()) as Task).status).toBe('merged')

    // Merged work isn't handed back to the PM: no turn, nothing unread
    await sleep(100)
    expect(runner.received.filter(m => m.type === 'run.assign' && m.job.role === 'pm' && m.job.projectId === project.id && m.job.runId !== job.runId)).toHaveLength(0)
    expect((await session(created.id)).unread).toBe(false)
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  })

  // Each Draft belongs to a Plan session, so it's listed on the Plan tab
  // even before its plan is approved (D10)
  describe('drafts by session', () => {
    async function proposeIn(project: { id: string }, text: string, tasksIn: Parameters<typeof plan>[0]) {
      const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text }).then(r => r.json()) as PlanSessionDetail
      const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.planSessionId === created.id)).job
      const result = await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan(tasksIn))
      expect(result).toMatchObject({ ok: true })
      await endTurn(job, 'Proposed.')
      return { session: created, job, planId: (result as { result: { planId: string } }).result.planId }
    }
    const getTask = async (ref: string) => t.request('GET', `/api/tasks/${ref}`).then(r => r.json()) as Promise<Task>
    const drafts = async (slug: string) => t.request('GET', `/api/projects/${slug}/drafts`).then(r => r.json()) as Promise<DraftSession[]>
    const lastTaskEvent = (taskId: string) => t.events.filter(e => e.type === 'task.updated' && e.task.id === taskId).at(-1) as { task: Task } | undefined
    const lastDraftsEvent = (projectId: string) => t.events.filter(e => e.type === 'plan.drafts' && e.projectId === projectId).at(-1) as { sessions: DraftSession[] } | undefined

    async function pausedProject() {
      const project = await t.createProject()
      await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
      return project
    }

    it('gives a Draft the session that proposed it, in task detail and live task events, and null once it leaves Draft', async () => {
      const project = await pausedProject()
      const backlog = await t.createTask(project.slug, { title: 'Already here' })
      const a = await proposeIn(project, 'Plan search', [{ title: 'Search box' }])
      const [item] = (await session(a.session.id)).plans[0]!.tasks
      const draft = await getTask(item!.ref!)
      expect(draft).toMatchObject({ status: 'draft', draftSession: { id: a.session.id, title: 'Plan search' } })
      expect(lastTaskEvent(draft.id)?.task).toMatchObject({ draftSession: { id: a.session.id, title: 'Plan search' } })
      expect(await getTask(backlog.ref)).toMatchObject({ status: 'backlog', draftSession: null })

      expect((await t.request('POST', `/api/plan/plans/${a.planId}/approve`, { to: 'backlog' })).status).toBe(200)
      expect(await getTask(draft.ref)).toMatchObject({ status: 'backlog', draftSession: null })
      expect(lastTaskEvent(draft.id)?.task).toMatchObject({ status: 'backlog', draftSession: null })
    })

    it('moves a Draft to the session whose plan revises it by ref, and back when that plan is discarded', async () => {
      const project = await pausedProject()
      const a = await proposeIn(project, 'Plan search', [{ title: 'Search box' }, { title: 'Search results' }])
      const [box, results] = (await session(a.session.id)).plans[0]!.tasks
      const b = await proposeIn(project, 'Refine search', [{ ref: box!.ref!, title: 'Search box with filters' }])

      expect(await getTask(box!.ref!)).toMatchObject({ status: 'draft', title: 'Search box', draftSession: { id: b.session.id, title: 'Refine search' } })
      expect(lastTaskEvent(box!.taskId!)?.task).toMatchObject({ draftSession: { id: b.session.id } })
      expect(await getTask(results!.ref!)).toMatchObject({ draftSession: { id: a.session.id } })
      expect(await drafts(project.slug)).toMatchObject([
        { sessionId: b.session.id, title: 'Refine search', planStatus: 'proposed', drafts: [{ ref: box!.ref, title: 'Search box' }] },
        { sessionId: a.session.id, title: 'Plan search', planStatus: 'proposed', drafts: [{ ref: results!.ref }] }
      ])

      // Discarding B only un-stages its revision: the Draft goes back to A
      const discarded = await t.request('POST', `/api/plan/plans/${b.planId}/discard`)
      expect(discarded.status).toBe(200)
      expect(await discarded.json() as Plan).toMatchObject({ status: 'discarded' })
      expect(await getTask(box!.ref!)).toMatchObject({ status: 'draft', title: 'Search box', draftSession: { id: a.session.id } })
      expect(lastTaskEvent(box!.taskId!)?.task).toMatchObject({ draftSession: { id: a.session.id } })
      expect((await session(b.session.id)).status).toBe('none')
      expect(await drafts(project.slug)).toMatchObject([{ sessionId: a.session.id, drafts: [{ ref: box!.ref }, { ref: results!.ref }] }])
    })

    it('lists drafts grouped by session, newest session first, and drops them when a plan is approved or discarded', async () => {
      const project = await pausedProject()
      expect(await drafts(project.slug)).toEqual([])
      const a = await proposeIn(project, 'Plan search', [{ title: 'Search box', type: 'bug', priority: 'high' }, { title: 'Search results', priority: 'low' }])
      const b = await proposeIn(project, 'Plan login', [{ title: 'Login form', type: 'spike', priority: 'urgent' }])
      const c = await proposeIn(project, 'Plan export', [{ title: 'CSV export' }])
      const refs = async (id: string) => (await session(id)).plans[0]!.tasks.map(x => x.ref!)
      const [box, results] = await refs(a.session.id)
      const [login] = await refs(b.session.id)
      const [csv] = await refs(c.session.id)

      const listed = await drafts(project.slug)
      expect(listed).toEqual([
        { sessionId: c.session.id, title: 'Plan export', updatedAt: expect.any(String), planStatus: 'proposed', drafts: [{ taskId: expect.any(String), ref: csv, title: 'CSV export', type: 'task', priority: 'medium' }] },
        { sessionId: b.session.id, title: 'Plan login', updatedAt: expect.any(String), planStatus: 'proposed', drafts: [{ taskId: expect.any(String), ref: login, title: 'Login form', type: 'spike', priority: 'urgent' }] },
        {
          sessionId: a.session.id,
          title: 'Plan search',
          updatedAt: expect.any(String),
          planStatus: 'proposed',
          drafts: [
            { taskId: expect.any(String), ref: box, title: 'Search box', type: 'bug', priority: 'high' },
            { taskId: expect.any(String), ref: results, title: 'Search results', type: 'task', priority: 'low' }
          ]
        }
      ])
      // Sent when the plan was proposed, before the turn ended and moved the session's updatedAt
      const withoutTime = (groups: DraftSession[] | undefined) => groups?.map(g => ({ ...g, updatedAt: null }))
      expect(withoutTime(lastDraftsEvent(project.id)?.sessions)).toEqual(withoutTime(listed))

      // Approving moves A's Drafts on; the live event carries the new list
      expect((await t.request('POST', `/api/plan/plans/${a.planId}/approve`, { to: 'backlog' })).status).toBe(200)
      expect((await drafts(project.slug)).map(g => g.sessionId)).toEqual([c.session.id, b.session.id])
      expect(lastDraftsEvent(project.id)?.sessions.map(g => g.sessionId)).toEqual([c.session.id, b.session.id])

      // Discarding deletes B's Drafts outright (D10)
      const loginId = (await session(b.session.id)).plans[0]!.tasks[0]!.taskId!
      expect((await t.request('POST', `/api/plan/plans/${b.planId}/discard`)).status).toBe(200)
      expect((await drafts(project.slug)).map(g => g.sessionId)).toEqual([c.session.id])
      expect(lastDraftsEvent(project.id)?.sessions.map(g => g.sessionId)).toEqual([c.session.id])
      expect(t.events).toContainEqual({ type: 'task.deleted', taskId: loginId, projectId: project.id })
      expect((await t.request('GET', `/api/tasks/${login}`)).status).toBe(404)
      // Only a proposed plan can be discarded
      expect((await t.request('POST', `/api/plan/plans/${b.planId}/discard`)).status).toBe(409)
      expect((await t.request('POST', `/api/plan/plans/${a.planId}/discard`)).status).toBe(409)
    })

    it('starts the next version afresh after a discard', async () => {
      const project = await pausedProject()
      const a = await proposeIn(project, 'Plan search', [{ title: 'Search box' }])
      expect((await t.request('POST', `/api/plan/plans/${a.planId}/discard`)).status).toBe(200)
      await t.request('POST', `/api/plan/sessions/${a.session.id}/messages`, { text: 'Try again' })
      const job = (await runner.next('run.assign', m => m.job.role === 'pm' && m.job.planSessionId === a.session.id && m.job.runId !== a.job.runId)).job
      expect(await runner.call(job.runId, job.leaseEpoch, 'propose_plan', plan([{ title: 'Search box' }]))).toMatchObject({ ok: true, result: { version: 2, tasks: [{ key: 't1', change: 'added' }] } })
      await endTurn(job, 'Proposed.')
      const plans = (await session(a.session.id)).plans
      expect(plans.map(p => p.status)).toEqual(['discarded', 'proposed'])
      expect(await drafts(project.slug)).toMatchObject([{ sessionId: a.session.id, drafts: [{ title: 'Search box' }] }])
    })
  })
})
