import type { AgentTool, AuditEntry, EpicDetail, PlanSessionDetail, RunJob, Task } from '@corral/contracts'
import { TASK_STATUSES } from '@corral/core'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { mkdir, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

describe('PM task and epic tools', () => {
  let t: TestApp
  let runner: FakeRunner
  let job: RunJob
  let session: PlanSessionDetail
  let slug: string
  let projectId: string
  const transcript: unknown[] = []
  const snapshots: Record<string, unknown> = {}
  const actor = () => ({ kind: 'agent', role: 'pm', runId: job.runId, sessionId: session.id })

  async function request(method: string, path: string, body?: unknown) {
    const response = await t.request(method, path, body)
    const result: unknown = response.status === 204 ? null : await response.json()
    transcript.push({ request: { method, path, body }, response: { status: response.status, body: result } })
    if (method === 'GET') snapshots[path.replace('/api', '')] = result
    return { status: response.status, body: result }
  }
  async function call(tool: AgentTool, input: unknown) {
    const response = await runner.call(job.runId, job.leaseEpoch, tool, input)
    transcript.push({ request: { transport: 'runner WebSocket', tool, input }, response })
    return response
  }
  async function action(tool: 'move_task' | 'approve_task' | 'delete_task' | 'stop_run', input: unknown) {
    const response = await call(tool, input)
    expect(response).toMatchObject({ ok: true, result: { confirmationPending: true } })
    return (response as { result: { actionId: string } }).result.actionId
  }
  const resolve = (id: string, decision = 'confirm') => request('POST', `/api/plan/sessions/${session.id}/actions/${id}`, { decision })
  const get = async (task: Task) => {
    await request('GET', `/api/projects/${slug}/tasks/${task.number}/comments`)
    await request('GET', `/api/runs?taskId=${task.id}`)
    await request('GET', `/api/projects/${slug}/tasks/${task.number}/evidence`)
    await request('GET', `/api/projects/${slug}/tasks/${task.number}/reviews`)
    return (await request('GET', `/api/projects/${slug}/tasks/${task.number}`)).body as Task
  }
  const history = async (task: Task) => (await request('GET', `/api/projects/${slug}/tasks/${task.number}/history`)).body as AuditEntry[]

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    runner = await FakeRunner.connect(t.server!.url)
    const project = await t.createProject({ name: 'Test app', repository: 'cormacrw/test-app', prefix: 'TA', defaultBranch: 'main' })
    projectId = project.id
    slug = project.slug
    await request('PATCH', `/api/projects/${slug}`, { paused: true })
    session = (await request('POST', '/api/plan/sessions', { projectId, text: 'Manage the test app tasks and epics' })).body as PlanSessionDetail
    job = (await runner.next('run.assign', m => m.job.planSessionId === session.id)).job
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'pm-task-tools' })
  })
  afterAll(async () => {
    if (process.env.CORRAL_PM_EVIDENCE_DIR) {
      await request('GET', `/api/plan/sessions/${session.id}`)
      await request('GET', '/api/projects')
      await request('GET', '/api/agents')
      await request('GET', `/api/projects/${slug}/epics`)
      await request('GET', `/api/projects/${slug}/tasks?view=all`)
      await request('GET', `/api/projects/${slug}/tasks`)
      await request('GET', `/api/runs?projectId=${projectId}`)
      await request('GET', '/api/plan/sessions')
      await request('GET', '/api/status')
      await request('GET', '/api/inbox')
      await mkdir(process.env.CORRAL_PM_EVIDENCE_DIR, { recursive: true })
      await writeFile(join(process.env.CORRAL_PM_EVIDENCE_DIR, 'pm-tool-requests.json'), JSON.stringify(transcript, null, 2))
      await writeFile(join(process.env.CORRAL_PM_EVIDENCE_DIR, 'pm-ui-responses.json'), JSON.stringify(snapshots, null, 2))
    }
    runner?.close()
    await t?.close()
  })

  it('creates outside a plan, edits every status and preserves criterion ids with PM session attribution', async () => {
    const created = await call('create_task', { title: 'A task outside a plan', type: 'task' })
    expect(created).toMatchObject({ ok: true, result: { status: 'backlog' } })
    const task = (created as { result: Task }).result
    expect(await history(task)).toContainEqual(expect.objectContaining({ action: 'task.created', actor: actor() }))
    for (const status of TASK_STATUSES) {
      await t.db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, task.id))
      expect(await call('update_task', { taskRef: task.ref, title: `Edited in ${status}`, priority: 'high', acceptanceCriteria: [{ text: `Works in ${status}` }] })).toMatchObject({ ok: true })
      const updated = await get(task)
      expect(updated).toMatchObject({ title: `Edited in ${status}`, status, priority: 'high', acceptanceCriteria: [{ text: `Works in ${status}` }] })
      const criterion = updated.acceptanceCriteria[0]!
      expect(await call('update_task', { taskRef: task.ref, acceptanceCriteria: [{ id: criterion.id, text: 'Reworded criterion' }] })).toMatchObject({ ok: true })
      expect((await get(task)).acceptanceCriteria[0]!.id).toBe(criterion.id)
    }
    expect((await history(task)).filter(e => e.action === 'task.updated').every(e => e.actor.kind === 'agent' && e.actor.sessionId === session.id)).toBe(true)
    expect(await call('update_task', { taskRef: 'OTHER-1', title: 'No' })).toMatchObject({ ok: false })
    expect(await call('update_task', { taskRef: task.ref, status: 'ready' })).toMatchObject({ ok: false })
  })

  it('updates description, type, review, epic and dependencies with the shared validations', async () => {
    const prerequisite = await t.createTask(slug)
    const task = await t.createTask(slug)
    const [epic] = await t.db.insert(schema.epics).values({ projectId, title: 'Editable group', createdBy: t.actor }).returning()
    const description = { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Investigate the behavior' }] }] }
    expect(await call('update_task', { taskRef: task.ref, description, type: 'spike', humanReview: true, epicId: epic!.id, dependsOn: [prerequisite.number] })).toMatchObject({ ok: true })
    expect(await get(task)).toMatchObject({ description, type: 'spike', humanReview: true, epicId: epic!.id, dependsOn: [prerequisite.ref] })
    expect(await call('update_task', { taskRef: prerequisite.ref, dependsOn: [task.number] })).toMatchObject({ ok: false })
    expect((await get(prerequisite)).dependsOn).toEqual([])
    expect(await call('update_task', { taskRef: task.ref, dependsOn: [], epicId: null, description: null })).toMatchObject({ ok: true, result: { dependsOn: [], epicId: null, description: null } })
  })

  it('delivers changed title, priority and criteria to the active developer and supports pause/resume', async () => {
    const task = await t.createTask(slug)
    await request('POST', `/api/projects/${slug}/tasks/${task.number}/transitions`, { type: 'approve' })
    await request('PATCH', `/api/projects/${slug}`, { paused: false })
    await t.orchestrator.schedule()
    const developer = (await runner.next('run.assign', m => m.job.taskId === task.id)).job
    runner.send({ type: 'run.started', runId: developer.runId, leaseEpoch: developer.leaseEpoch, agentSessionId: 'live-developer' })
    await expect.poll(async () => (await t.db.select().from(schema.runs).where(eq(schema.runs.id, developer.runId)))[0]?.state).toBe('running')
    await request('PATCH', `/api/projects/${slug}`, { paused: true })
    expect(await call('update_task', { taskRef: task.ref, title: 'Use the shared form', priority: 'urgent', acceptanceCriteria: [{ text: 'The shared form validates email' }] })).toMatchObject({ ok: true })
    const message = await runner.next('run.message', m => m.runId === developer.runId)
    transcript.push({ deliveredToDeveloper: message })
    expect(message.text).toContain('Use the shared form')
    expect(message.text).toContain('urgent')
    expect(message.text).toContain('The shared form validates email')
    expect(await history(task)).toContainEqual(expect.objectContaining({ action: 'run.message_sent', actor: actor() }))
    expect(await call('update_task', { taskRef: task.ref, paused: true, title: 'Must not save' })).toMatchObject({ ok: false, error: expect.stringContaining('Use stop_run') })
    expect(await get(task)).toMatchObject({ paused: false, title: 'Use the shared form' })
    expect((await t.db.select().from(schema.runs).where(eq(schema.runs.id, developer.runId)))[0]?.state).toBe('running')
    const stop = await action('stop_run', { runId: developer.runId })
    expect((await get(task)).paused).toBe(false)
    expect((await resolve(stop)).body).toMatchObject({ pendingAction: { status: 'confirmed' } })
    expect(await runner.next('run.stop', m => m.runId === developer.runId)).toMatchObject({ keepWork: true })
    expect(await call('update_task', { taskRef: task.ref, paused: true })).toMatchObject({ ok: true, result: { paused: true } })
    expect(await call('update_task', { taskRef: task.ref, paused: false })).toMatchObject({ ok: true, result: { paused: false } })
    await get(task)
    await history(task)
  })

  it('confirms board moves, records the reason and returns the board error for invalid moves', async () => {
    const task = await t.createTask(slug)
    // D27 requires human confirmation for human-only board transitions.
    const id = await action('move_task', { taskRef: task.ref, transition: { type: 'send_back' }, reason: 'Needs refinement' })
    const board = await request('POST', `/api/projects/${slug}/tasks/${task.number}/transitions`, { type: 'send_back' })
    const failed = await resolve(id)
    expect(failed.body).toMatchObject({ pendingAction: { status: 'failed', error: JSON.stringify((board.body as { error: unknown }).error) } })
    await t.db.update(schema.tasks).set({ status: 'ready' }).where(eq(schema.tasks.id, task.id))
    const move = await action('move_task', { taskRef: task.ref, transition: { type: 'send_back' }, reason: 'Needs refinement' })
    expect((await get(task)).status).toBe('ready')
    expect((await resolve(move)).body).toMatchObject({ pendingAction: { status: 'confirmed' } })
    expect((await get(task)).status).toBe('backlog')
    expect((await history(task)).find(e => e.action === 'task.transition')?.actor).toMatchObject({ kind: 'human', viaPm: { sessionId: session.id, runId: job.runId } })
    expect((await request('GET', `/api/projects/${slug}/tasks/${task.number}/comments`)).body).toContainEqual(expect.objectContaining({ body: 'Needs refinement' }))
    for (const [status, transition, expected] of [
      ['backlog', { type: 'approve' }, 'ready'],
      ['draft', { type: 'accept' }, 'backlog'],
      ['human_review', { type: 'human_request_changes', feedback: 'Add validation' }, 'in_progress'],
      ['ready_to_merge', { type: 'human_request_changes' }, 'in_progress']
    ] as const) {
      await t.db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, task.id))
      const proposal = await action('move_task', { taskRef: task.ref, transition })
      const [card] = await t.db.select().from(schema.planMessages).where(eq(schema.planMessages.id, proposal))
      if ('feedback' in transition) expect(card!.pendingAction!.summary).toContain(transition.feedback)
      if (transition.type === 'accept') expect(card!.pendingAction!.summary).toContain('to backlog')
      expect((await resolve(proposal)).body).toMatchObject({ pendingAction: { status: 'confirmed' } })
      expect((await get(task)).status).toBe(expected)
    }
    for (const status of ['blocked', 'failed'] as const) {
      for (const to of ['backlog', 'ready', 'in_progress'] as const) {
        await t.db.update(schema.tasks).set({ status }).where(eq(schema.tasks.id, task.id))
        const proposal = await action('move_task', { taskRef: task.ref, transition: { type: 'resolve', to } })
        expect((await resolve(proposal)).body).toMatchObject({ pendingAction: { status: 'confirmed' } })
        expect((await get(task)).status).toBe(to)
      }
    }
  })

  it('refuses generic design approval and binds approval to the full reviewed head', async () => {
    const design = await t.createTask(slug, { title: 'Design prototype', type: 'design' })
    await t.db.update(schema.tasks).set({ status: 'human_review' }).where(eq(schema.tasks.id, design.id))
    expect(await call('approve_task', { taskRef: design.ref })).toMatchObject({ ok: false, error: expect.stringContaining('Use approve_design') })
    expect((await get(design)).status).toBe('human_review')
    const task = await t.createTask(slug)
    const oldHead = 'a'.repeat(40)
    // Two heads sharing a short prefix must still invalidate the old card.
    const newHead = 'a'.repeat(39) + 'b'
    await t.db.update(schema.tasks).set({ status: 'human_review', prNumber: 42, headSha: oldHead }).where(eq(schema.tasks.id, task.id))
    const proposal = await action('approve_task', { taskRef: task.ref })
    const [card] = await t.db.select().from(schema.planMessages).where(eq(schema.planMessages.id, proposal))
    expect(card!.pendingAction!.summary).toContain('PR #42 at ' + oldHead)
    await t.db.update(schema.tasks).set({ status: 'in_progress' }).where(eq(schema.tasks.id, task.id))
    await t.db.update(schema.tasks).set({ status: 'human_review', headSha: newHead }).where(eq(schema.tasks.id, task.id))
    expect((await resolve(proposal)).body).toMatchObject({ pendingAction: { status: 'failed' } })
    expect((await get(task)).status).toBe('human_review')
  })

  it('keeps human Merged edits read-only while permitting PM metadata edits', async () => {
    const task = await t.createTask(slug)
    await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, task.id))
    expect(await request('PATCH', `/api/projects/${slug}/tasks/${task.number}`, { title: 'Human edit' })).toMatchObject({ status: 409 })
    expect(await call('update_task', { taskRef: task.ref, title: 'PM metadata edit' })).toMatchObject({ ok: true })
    expect(await get(task)).toMatchObject({ status: 'merged', title: 'PM metadata edit' })
  })

  it('requires human confirmation for approval and deletion, and revalidates changed approval state', async () => {
    const task = await t.createTask(slug, { title: 'Ready for human review', type: 'spike' })
    await t.db.update(schema.tasks).set({ status: 'human_review' }).where(eq(schema.tasks.id, task.id))
    const cancelled = await action('approve_task', { taskRef: task.ref })
    expect((await get(task)).status).toBe('human_review')
    await resolve(cancelled, 'cancel')
    expect((await get(task)).status).toBe('human_review')
    const stale = await action('approve_task', { taskRef: task.ref })
    await t.db.update(schema.tasks).set({ status: 'ready' }).where(eq(schema.tasks.id, task.id))
    expect((await resolve(stale)).body).toMatchObject({ pendingAction: { status: 'failed' } })
    await t.db.update(schema.tasks).set({ status: 'human_review' }).where(eq(schema.tasks.id, task.id))
    const approve = await action('approve_task', { taskRef: task.ref })
    expect((await resolve(approve)).body).toMatchObject({ pendingAction: { status: 'confirmed' } })
    expect((await get(task)).status).toBe('merged')
    await history(task)
    const disposable = await t.createTask(slug, { title: 'Delete only after confirmation' })
    const remove = await action('delete_task', { taskRef: disposable.ref })
    expect((await get(disposable)).title).toBe(disposable.title)
    expect((await resolve(remove)).body).toMatchObject({ pendingAction: { status: 'confirmed' } })
    expect((await request('GET', `/api/projects/${slug}/tasks/${disposable.number}`)).status).toBe(404)
    // Leave both types of card pending for the UI evidence as well.
    await t.db.update(schema.tasks).set({ status: 'human_review' }).where(eq(schema.tasks.id, task.id))
    await action('approve_task', { taskRef: task.ref })
    const pendingDelete = await t.createTask(slug, { title: 'Old welcome page' })
    await action('delete_task', { taskRef: pendingDelete.ref })
  })

  it('edits epic metadata and dependencies atomically, audits them and refuses foreign epics', async () => {
    const [first, second] = await t.db.insert(schema.epics).values(['Foundation', 'Application'].map(title => ({ projectId, title, createdBy: t.actor }))).returning()
    expect(await call('update_epic', { epicId: second!.id, title: 'Application delivery', summary: 'Build on the foundation', reviewMode: 'each_task', dependsOn: [first!.id] })).toMatchObject({ ok: true, result: { title: 'Application delivery', reviewMode: 'each_task', dependsOn: [first!.id] } })
    const activity = (await request('GET', `/api/epics/${second!.id}/history`)).body as AuditEntry[]
    expect(activity).toContainEqual(expect.objectContaining({ actor: actor(), action: 'epic.updated', detail: { epicId: second!.id, changed: expect.arrayContaining(['title', 'description', 'reviewMode']) } }))
    expect(activity).toContainEqual(expect.objectContaining({ actor: actor(), detail: { epicId: second!.id, changed: ['dependsOn'], dependsOn: [first!.id] } }))
    expect(await call('update_epic', { epicId: first!.id, title: 'Must roll back', dependsOn: [second!.id] })).toMatchObject({ ok: false })
    expect(((await request('GET', `/api/epics/${first!.id}`)).body as EpicDetail).title).toBe('Foundation')
    await request('GET', `/api/epics/${second!.id}`)
    const foreignProject = await t.createProject()
    const [foreign] = await t.db.insert(schema.epics).values({ projectId: foreignProject.id, title: 'Foreign', createdBy: t.actor }).returning()
    expect(await call('update_epic', { epicId: foreign!.id, title: 'No' })).toMatchObject({ ok: false })
    expect(await call('update_epic', { epicId: second!.id, dependsOn: [foreign!.id] })).toMatchObject({ ok: false })
  })
})
