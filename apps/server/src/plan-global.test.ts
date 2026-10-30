import type { PlanSessionDetail, RunJob, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq, sql } from 'drizzle-orm'
import { readFile, writeFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'

// Real HTTP and fenced runner tool requests against an isolated database.
describe('global and project Plan sessions', () => {
  let t: TestApp
  let runner: FakeRunner
  const evidence: unknown[] = []
  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    runner = await FakeRunner.connect(t.server!.url)
  })
  afterAll(async () => {
    if (process.env.CORRAL_GLOBAL_EVIDENCE) await writeFile(process.env.CORRAL_GLOBAL_EVIDENCE, JSON.stringify(evidence, null, 2))
    runner?.close()
    await t?.close()
  })
  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`${t.server!.url}/api${path}`, {
      method,
      ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })
    })
    const result: unknown = await response.json()
    evidence.push({ method, path, body, status: response.status, response: result })
    expect(response.ok).toBe(true)
    return result
  }
  async function call(job: RunJob, tool: Parameters<FakeRunner['call']>[2], input: unknown) {
    const result = await runner.call(job.runId, job.leaseEpoch, tool, input)
    evidence.push({ transport: 'runner WebSocket', runId: job.runId, tool, input, response: result })
    return result
  }
  async function finish(job: RunJob, reply: string) {
    runner.send({ type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [{ type: 'message', text: reply }] })
    await sleep(50)
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
    await expect.poll(async () => {
      const session = await t.request('GET', `/api/plan/sessions/${job.planSessionId}`).then(r => r.json()) as PlanSessionDetail
      return session.activeRunId === null && session.messages.some(m => m.text === reply)
    }).toBe(true)
  }

  it('preserves project and conversation history when the nullable migration is applied', async () => {
    // Recreate the old constraints before seeding a pre-migration conversation.
    await t.db.execute(sql.raw('ALTER TABLE plan_sessions ALTER COLUMN project_id SET NOT NULL'))
    await t.db.execute(sql.raw('ALTER TABLE runs ALTER COLUMN project_id SET NOT NULL'))
    const project = await t.createProject({ name: 'Existing project', repository: 'fixture/existing' })
    const [session] = await t.db.insert(schema.planSessions).values({ projectId: project.id, title: 'Existing conversation', createdBy: t.actor }).returning()
    await t.db.insert(schema.planMessages).values([
      { sessionId: session!.id, role: 'human', text: 'Remember this project discussion' },
      { sessionId: session!.id, role: 'pm', text: 'The original reply stays in history' }
    ])
    const before = await request('GET', `/plan/sessions/${session!.id}`)
    const migration = await readFile(new URL('../../../packages/db/migrations/0036_natural_santa_claus.sql', import.meta.url), 'utf8')
    for (const statement of migration.split('--> statement-breakpoint')) await t.db.execute(sql.raw(statement))
    evidence.push({ migration: '0036_natural_santa_claus.sql', sql: migration, baseline: 'Both project_id columns were NOT NULL; the session and its messages existed before applying this migration.' })
    const after = await request('GET', `/plan/sessions/${session!.id}`)
    expect(after).toEqual(before)
    expect(after).toMatchObject({ projectId: project.id, messages: [expect.objectContaining({ text: 'Remember this project discussion' }), expect.objectContaining({ text: 'The original reply stays in history' })] })
  })

  it('proposes drafts for an explicit project and discards only its own drafts on close', async () => {
    const project = await t.createProject({ name: 'Plan destination', repository: 'fixture/drafts' })
    await request('PATCH', `/projects/${project.slug}`, { paused: true })
    const existing = await t.createTask(project.slug)
    const session = await request('POST', '/plan/sessions', { projectId: null, text: 'Plan for another project' }) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.planSessionId === session.id)).job
    const proposal = await call(job, 'propose_plan', {
      project: project.slug, title: 'A global plan',
      tasks: [{ key: 'one', title: 'New draft', type: 'task', description: 'Build a screen', acceptanceCriteria: ['The screen opens'] }]
    })
    expect(proposal).toMatchObject({ ok: true })
    const detail = await request('GET', `/plan/sessions/${session.id}`) as PlanSessionDetail
    expect(detail.plans[0]?.projectId).toBe(project.id)
    const draftId = detail.plans[0]!.tasks[0]!.taskId!
    await finish(job, 'The plan is ready for review.')
    await request('POST', `/plan/sessions/${session.id}/close`)
    expect((await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, draftId)))[0]?.deletedAt).not.toBeNull()
    expect((await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, existing.id)))[0]?.deletedAt).toBeNull()
  })

  it('confirms delete_task on the named project from a global session', async () => {
    const project = await t.createProject({ name: 'Confirm target', repository: 'fixture/confirm' })
    await request('PATCH', `/projects/${project.slug}`, { paused: true })
    const task = await t.createTask(project.slug, { title: 'Delete me' })
    const session = await request('POST', '/plan/sessions', { text: 'Tidy the board' }) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.planSessionId === session.id)).job
    const proposal = await call(job, 'delete_task', { project: project.slug, taskRef: task.ref })
    expect(proposal).toMatchObject({ ok: true, result: { confirmationPending: true } })
    const { actionId } = (proposal as { result: { actionId: string } }).result
    await finish(job, 'Waiting for your confirmation.')
    expect(await request('POST', `/plan/sessions/${session.id}/actions/${actionId}`, { decision: 'confirm' })).toMatchObject({ pendingAction: { status: 'confirmed', input: { project: project.slug } } })
    expect((await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}`)).status).toBe(404)
    const [confirmed] = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'pm.action_confirmed'))
    expect(confirmed).toMatchObject({ projectId: project.id })
  })

  it('scopes the added task and epic tools globally and across project sessions', async () => {
    const a = await t.createProject({ name: 'Editing default', repository: 'fixture/edit-default' })
    const b = await t.createProject({ name: 'Editing override', repository: 'fixture/edit-override' })
    for (const project of [a, b]) await request('PATCH', `/projects/${project.slug}`, { paused: true })
    const global = await request('POST', '/plan/sessions', { text: 'Manage tasks globally' }) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.planSessionId === global.id)).job
    const created = await call(job, 'create_task', { project: b.slug, title: 'Global task', type: 'task', description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Show the screen' }] }] }, acceptanceCriteria: ['The screen opens'] })
    expect(created).toMatchObject({ ok: true, result: { projectId: b.id } })
    const task = (created as { result: Task }).result
    expect(await call(job, 'update_task', { project: b.slug, taskRef: task.ref, title: 'Updated globally' })).toMatchObject({ ok: true, result: { title: 'Updated globally', projectId: b.id } })
    const [epic] = await t.db.insert(schema.epics).values({ projectId: b.id, title: 'Epic to edit', createdBy: t.actor }).returning()
    if (!epic) throw new Error('Epic fixture was not created')
    expect(await call(job, 'update_epic', { project: b.slug, epicId: epic.id, title: 'Edited globally' })).toMatchObject({ ok: true, result: { title: 'Edited globally', projectId: b.id } })
    const move = await call(job, 'move_task', { project: b.slug, taskRef: task.ref, transition: { type: 'approve' } })
    expect(move).toMatchObject({ ok: true, result: { confirmationPending: true } })
    await finish(job, 'Confirm the board move.')
    const actionId = (move as { result: { actionId: string } }).result.actionId
    expect(await request('POST', `/plan/sessions/${global.id}/actions/${actionId}`, { decision: 'confirm' })).toMatchObject({ pendingAction: { status: 'confirmed', input: { project: b.slug } } })
    expect(await request('GET', `/projects/${b.slug}/tasks/${task.number}`)).toMatchObject({ projectId: b.id, status: 'ready' })

    const session = await request('POST', '/plan/sessions', { projectId: a.id, text: 'Edit both projects' }) as PlanSessionDetail
    const projectJob = (await runner.next('run.assign', m => m.job.planSessionId === session.id)).job
    const defaultTask = await call(projectJob, 'create_task', { title: 'Default task', type: 'task' })
    const otherTask = await call(projectJob, 'create_task', { project: b.slug, title: 'Other task', type: 'task' })
    expect(defaultTask).toMatchObject({ ok: true, result: { projectId: a.id } })
    expect(otherTask).toMatchObject({ ok: true, result: { projectId: b.id } })
    expect(await call(projectJob, 'update_task', { taskRef: (defaultTask as { result: Task }).result.ref, title: 'Default edit' })).toMatchObject({ ok: true, result: { projectId: a.id, title: 'Default edit' } })
    expect(await call(projectJob, 'update_task', { project: b.slug, taskRef: (otherTask as { result: Task }).result.ref, title: 'Other edit' })).toMatchObject({ ok: true, result: { projectId: b.id, title: 'Other edit' } })
    expect(await call(projectJob, 'update_epic', { project: b.slug, epicId: epic.id, title: 'Edited from another project' })).toMatchObject({ ok: true, result: { projectId: b.id } })
    await finish(projectJob, 'Both projects edited.')
  })

  it('runs factory tools without a project and removes a project from a global session', async () => {
    const project = await t.createProject({ name: 'Remove me', repository: 'fixture/remove' })
    const session = await request('POST', '/plan/sessions', { text: 'Clean up' }) as PlanSessionDetail
    const job = (await runner.next('run.assign', m => m.job.planSessionId === session.id)).job
    expect(await call(job, 'get_status', {})).toMatchObject({ ok: true })
    expect(await call(job, 'list_projects', {})).toMatchObject({ ok: true })
    expect(await call(job, 'list_inbox', {})).toMatchObject({ ok: true })
    expect(await call(job, 'get_run', { runId: job.runId })).toMatchObject({ ok: true, result: { projectId: null } })
    expect(await call(job, 'message_run', { runId: job.runId, text: 'Hello' })).toMatchObject({ ok: false, error: expect.stringContaining('only developer and reviewer runs') })
    const proposal = await call(job, 'delete_project', { project: project.slug })
    expect(proposal).toMatchObject({ ok: true, result: { confirmationPending: true } })
    const { actionId } = (proposal as { result: { actionId: string } }).result
    await finish(job, 'Waiting for your confirmation.')
    expect(await request('POST', `/plan/sessions/${session.id}/actions/${actionId}`, { decision: 'confirm' })).toMatchObject({ pendingAction: { status: 'confirmed' } })
    expect((await t.request('GET', `/api/projects/${project.slug}`)).status).toBe(404)
  })

  it('requires explicit projects globally, defaults project threads, and preserves history', async () => {
    const a = await t.createProject({ name: 'Test app', prefix: 'TA', repository: 'cormacrw/test-app' })
    const b = await t.createProject({ name: 'Other test app', prefix: 'TB', repository: 'fixture/other' })
    await request('PATCH', `/projects/${a.slug}`, { paused: true })
    await request('PATCH', `/projects/${b.slug}`, { paused: true })
    const taskA = await t.createTask(a.slug, { title: 'Board A' })
    const taskB = await t.createTask(b.slug, { title: 'Board B' })
    const global = await request('POST', '/plan/sessions', { text: 'Show me the boards' }) as PlanSessionDetail
    expect(global.projectId).toBeNull()
    const job = (await runner.next('run.assign', m => m.job.planSessionId === global.id)).job
    evidence.push({ globalJob: job })
    expect(job).toMatchObject({ projectId: null, repository: '', defaultBranch: '' })
    expect(job.prompt).toContain('no repository checkout or worktree')
    expect(job.prompt).toContain('Start a project thread when you need to read code')
    expect(await call(job, 'list_tasks', { project: a.slug })).toMatchObject({ ok: true, result: { project: { prefix: 'TA' }, tasks: [{ ref: taskA.ref }] } })
    for (const tool of ['list_tasks', 'get_task', 'propose_plan', 'flag_stale_docs', 'get_design', 'get_attachment', 'delete_task', 'create_task', 'update_task', 'move_task', 'approve_task', 'update_epic'] as const) {
      expect(await call(job, tool, {})).toMatchObject({ ok: false, error: expect.stringContaining('project') })
    }
    expect(await call(job, 'list_tasks', { project: 'missing' })).toMatchObject({ ok: false, error: 'Unknown project: missing' })
    expect(await call(job, 'ask_question', { question: 'Which board next?' })).toMatchObject({ ok: true })
    await finish(job, 'I checked the Test app board.')
    expect(await request('GET', `/runs/${job.runId}`)).toMatchObject({ projectId: null, state: 'completed' })
    expect(await request('GET', '/inbox')).toMatchObject({ needsYou: expect.arrayContaining([expect.objectContaining({ sessionId: global.id, project: null })]) })
    await request('POST', `/plan/sessions/${global.id}/messages`, { text: 'Continue' })
    const followup = (await runner.next('run.assign', m => m.job.planSessionId === global.id)).job
    expect(followup.projectId).toBeNull()
    await finish(followup, 'Still global.')

    const project = await request('POST', '/plan/sessions', { projectId: a.id, text: 'Show this board' }) as PlanSessionDetail
    const projectJob = (await runner.next('run.assign', m => m.job.planSessionId === project.id)).job
    expect(await call(projectJob, 'list_tasks', {})).toMatchObject({ ok: true, result: { tasks: [{ ref: taskA.ref }] } })
    expect(await call(projectJob, 'get_task', { taskRef: taskA.ref })).toMatchObject({ ok: true, result: { title: 'Board A' } })
    expect(await call(projectJob, 'list_tasks', { project: b.slug })).toMatchObject({ ok: true, result: { project: { prefix: 'TB' }, tasks: [{ ref: taskB.ref }] } })
    expect(await call(projectJob, 'get_task', { project: b.slug, taskRef: taskB.ref })).toMatchObject({ ok: true, result: { title: 'Board B' } })
    expect(await call(projectJob, 'flag_stale_docs', { project: b.slug, title: 'Update docs', description: 'Document the current behaviour' })).toMatchObject({ ok: true })
    await finish(projectJob, 'Both boards checked.')
    expect(await request('GET', `/plan/sessions/${project.id}`)).toMatchObject({ projectId: a.id, messages: [expect.objectContaining({ text: 'Show this board' }), expect.objectContaining({ text: 'Both boards checked.' })] })
    expect(await request('GET', '/plan/sessions')).toEqual(expect.arrayContaining([expect.objectContaining({ id: global.id, projectId: null }), expect.objectContaining({ id: project.id, projectId: a.id })]))

    await request('POST', `/plan/sessions/${global.id}/close`)
    expect((await t.db.select().from(schema.planSessions).where(eq(schema.planSessions.id, project.id)))[0]?.projectId).toBe(a.id)
  })
})
