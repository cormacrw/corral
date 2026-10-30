import type { Inbox, AgentTool, PlanMessage, PlanSession, PlanSessionDetail, RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { writeFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'

// Exercise the actual HTTP session services and fenced runner WebSocket tools.
describe('PM threads', () => {
  let t: TestApp
  let runner: FakeRunner
  let parent: PlanSessionDetail
  let parentJob: RunJob
  let child: PlanSessionDetail
  let childJob: RunJob
  let otherChild: PlanSessionDetail
  const evidence: unknown[] = []
  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    runner = await FakeRunner.connect(t.server!.url)
  })
  afterAll(async () => {
    if (process.env.CORRAL_THREAD_EVIDENCE) await writeFile(process.env.CORRAL_THREAD_EVIDENCE, JSON.stringify(evidence, null, 2))
    runner?.close()
    await t?.close()
  })
  async function request(method: string, path: string, body?: unknown) {
    const res = await fetch(`${t.server!.url}/api${path}`, { method, ...(body !== undefined && { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }) })
    const response: unknown = await res.json()
    evidence.push({ method, path, body, status: res.status, response })
    expect(res.ok).toBe(true)
    return response
  }
  async function call<T>(job: RunJob, tool: AgentTool, input: unknown): Promise<T> {
    const response = await runner.call(job.runId, job.leaseEpoch, tool, input)
    evidence.push({ transport: 'runner WebSocket', tool, input, response })
    expect(response.ok).toBe(true)
    if (!response.ok) throw new Error(response.error)
    return response.result as T
  }
  async function finish(job: RunJob, reply: string) {
    runner.send({ type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [{ type: 'message', text: reply }] })
    await sleep(50)
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
    await expect.poll(async () => (await t.plans.getSession(job.planSessionId!)).activeRunId).toBeNull()
  }

  it('starts project and global children with explicit titles, attribution and a first PM turn', async () => {
    const project = await t.createProject({ name: 'Test app', repository: 'cormacrw/test-app', defaultBranch: 'main' })
    await request('PATCH', `/projects/${project.slug}`, { paused: true })
    parent = await request('POST', '/plan/sessions', { text: 'Coordinate the investigation' }) as PlanSessionDetail
    parentJob = (await runner.next('run.assign', m => m.job.planSessionId === parent.id)).job
    child = await call(parentJob, 'start_thread', { title: 'Inspect test app', project: project.slug, message: 'Read the code and report findings', runtime: 'codex' })
    childJob = (await runner.next('run.assign', m => m.job.planSessionId === child.id)).job
    evidence.push({ transport: 'runner WebSocket', event: 'run.assign', job: childJob })
    expect(child).toMatchObject({ title: 'Inspect test app', parentSessionId: parent.id, projectId: project.id, runtime: 'codex', messages: [{ role: 'thread', senderSessionId: parent.id, text: 'Read the code and report findings' }] })
    expect(childJob).toMatchObject({ role: 'pm', projectId: project.id, runtime: 'codex', repository: 'cormacrw/test-app' })
    expect(childJob.prompt).toContain(`Message from PM thread “${parent.title}” (${parent.id})`)
    expect(childJob.prompt).toContain('Read the code and report findings')
    const global = await call<PlanSessionDetail>(parentJob, 'start_thread', { title: 'Global helper', message: 'Check factory status' })
    expect(global).toMatchObject({ projectId: null, parentSessionId: parent.id })
    const job = (await runner.next('run.assign', m => m.job.planSessionId === global.id)).job
    await finish(job, 'Factory status checked.')
    const other = await t.createProject({ name: 'Other project', repository: 'fixture/other-thread' })
    await request('PATCH', `/projects/${other.slug}`, { paused: true })
    otherChild = await call(parentJob, 'start_thread', { title: 'Other project helper', project: other.slug, message: 'Read this project too' })
    const otherJob = (await runner.next('run.assign', m => m.job.planSessionId === otherChild.id)).job
    await finish(otherJob, 'Other project checked.')
  })

  it('notifies a running parent without starting another turn, and lists and reads across projects', async () => {
    await call(parentJob, 'ask_question', { question: 'Which entry point should we prioritize?' })
    await call(childJob, 'propose_plan', { title: 'Check entry point', tasks: [{ key: 'entry', title: 'Review entry point', type: 'task', description: 'Review the app entry point', acceptanceCriteria: ['The entry point opens'] }] })
    await finish(childJob, 'The test app has a small web entry point.')
    await expect.poll(async () => (await t.plans.getSession(parent.id)).messages.some(m => m.senderSessionId === child.id)).toBe(true)
    const detail = await request('GET', `/plan/sessions/${parent.id}`) as PlanSessionDetail
    expect(detail.activeRunId).toBe(parentJob.runId)
    expect(detail.status).toBe('question')
    expect(detail.unread).toBe(false)
    const inbox = await request('GET', '/inbox') as Inbox
    expect(inbox.needsYou).toContainEqual(expect.objectContaining({ sessionId: parent.id, status: 'question', question: expect.objectContaining({ text: 'Which entry point should we prioritize?' }) }))
    expect(detail.messages).toContainEqual(expect.objectContaining({ role: 'thread', kind: 'notification', senderSessionId: child.id, text: expect.stringContaining('Inspect test app') }))
    const list = await call<(PlanSession & { running: boolean, project: string | null })[]>(parentJob, 'list_threads', {})
    expect(list).toEqual(expect.arrayContaining([expect.objectContaining({ id: parent.id, project: null, running: true }), expect.objectContaining({ id: child.id, parentSessionId: parent.id, project: 'test-app', running: false })]))
    expect(list).toContainEqual(expect.objectContaining({ id: otherChild.id, project: 'other-project', parentSessionId: parent.id }))
    const otherRecent = await call<PlanSessionDetail>(parentJob, 'read_thread', { threadId: otherChild.id, limit: 1 })
    expect(otherRecent.messages[0]?.text).toBe('Other project checked.')
    const recent = await call<PlanSessionDetail>(parentJob, 'read_thread', { threadId: child.id, limit: 1 })
    expect(recent.messages).toMatchObject([{ role: 'pm', text: 'The test app has a small web entry point.' }])
    const all = await call<PlanSessionDetail>(parentJob, 'read_thread', { threadId: child.id, limit: 3 })
    expect(all.messages.map(m => m.role)).toEqual(['pm', 'pm', 'thread'])
    expect(await runner.call(parentJob.runId, parentJob.leaseEpoch, 'read_thread', { threadId: child.id, limit: 0 })).toMatchObject({ ok: false })
  })

  it('delivers thread messages with a sender label and never treats them as human plan authorization', async () => {
    const message = await call<PlanMessage>(parentJob, 'message_thread', { threadId: child.id, message: 'Check the entry point again' })
    expect(message).toMatchObject({ role: 'thread', senderSessionId: parent.id, senderTitle: parent.title })
    childJob = (await runner.next('run.assign', m => m.job.planSessionId === child.id)).job
    const detail = await request('GET', `/plan/sessions/${child.id}`) as PlanSessionDetail
    expect(detail.messages.at(-1)).toMatchObject(message)
    expect(childJob.prompt).toContain('not from the human')
    expect(await runner.call(childJob.runId, childJob.leaseEpoch, 'approve_plan', { to: 'backlog' })).toMatchObject({ ok: false, error: expect.stringContaining('human hasn') })
    await finish(childJob, 'Entry point checked again.')
    await finish(parentJob, 'Waiting for a follow-up.')
    // Warm sessions need database notifications too, not only cold history.
    await t.db.update(schema.planSessions).set({ agentSessionId: 'warm-session' }).where(eq(schema.planSessions.id, parent.id))
    await request('POST', `/plan/sessions/${parent.id}/messages`, { text: 'Continue' })
    parentJob = (await runner.next('run.assign', m => m.job.planSessionId === parent.id)).job
    expect(parentJob.prompt).toContain('Inspect test app')
    expect(parentJob.prompt).toContain('finished its turn')
    evidence.push({ event: 'warm parent turn prompt', prompt: parentJob.prompt })
  })

  it('refuses discarding plans or owned Drafts, then closes an empty thread and reopens on an agent message', async () => {
    const before = await request('GET', `/plan/sessions/${child.id}`) as PlanSessionDetail
    const refused = await runner.call(parentJob.runId, parentJob.leaseEpoch, 'close_thread', { threadId: child.id })
    evidence.push({ transport: 'runner WebSocket', tool: 'close_thread', input: { threadId: child.id }, response: refused })
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('Ask the human') })
    expect(await request('GET', `/plan/sessions/${child.id}`)).toMatchObject({ closed: false, plans: [{ status: 'proposed', tasks: [{ status: 'draft' }] }] })
    // Even without a proposed plan, owned Drafts cannot be discarded by an agent.
    await t.db.update(schema.plans).set({ status: 'superseded' }).where(eq(schema.plans.id, before.plans[0]!.id))
    expect(await runner.call(parentJob.runId, parentJob.leaseEpoch, 'close_thread', { threadId: child.id })).toMatchObject({ ok: false })
    await request('POST', `/plan/sessions/${child.id}/close`)
    const beforeInbox = await request('GET', '/inbox') as Inbox
    expect(beforeInbox.needsYou.some(i => i.type === 'plan_thread' && i.sessionId === parent.id)).toBe(false)
    await call(parentJob, 'message_thread', { threadId: child.id, message: 'Begin another check' })
    const interrupted = (await runner.next('run.assign', m => m.job.planSessionId === child.id)).job
    const closed = await call<PlanSession>(parentJob, 'close_thread', { threadId: child.id })
    expect(closed).toMatchObject({ closed: true, activeRunId: null })
    const stopped = await runner.next('run.stop', m => m.runId === interrupted.runId)
    evidence.push({ transport: 'runner WebSocket', event: 'run.stop', response: stopped })
    expect(await runner.call(interrupted.runId, interrupted.leaseEpoch, 'list_threads', {})).toMatchObject({ ok: false })
    expect(await request('GET', `/plan/sessions/${parent.id}`)).toMatchObject({ unread: false })
    const afterInbox = await request('GET', '/inbox') as Inbox
    expect(afterInbox.needsYou.some(i => i.type === 'plan_thread' && i.sessionId === parent.id)).toBe(false)
    await t.orchestrator.tick()
    expect(await request('GET', `/plan/sessions/${child.id}`)).toMatchObject({ closed: true, activeRunId: null })
    await call(parentJob, 'message_thread', { threadId: child.id, message: 'One more check' })
    childJob = (await runner.next('run.assign', m => m.job.planSessionId === child.id)).job
    expect(await request('GET', `/plan/sessions/${child.id}`)).toMatchObject({ closed: false, activeRunId: childJob.runId })
    await finish(childJob, 'Final check done.')
    await finish(parentJob, 'All checks received.')
  })

  it('keeps a closed parent closed on child completion, and replays the notification on a human turn', async () => {
    await request('POST', `/plan/sessions/${child.id}/messages`, { text: 'Check once more' })
    const job = (await runner.next('run.assign', m => m.job.planSessionId === child.id)).job
    await request('POST', `/plan/sessions/${parent.id}/close`)
    await finish(job, 'The final child turn is done.')
    await expect.poll(async () => (await t.plans.getSession(parent.id)).messages.at(-1)?.kind).toBe('notification')
    expect(await request('GET', `/plan/sessions/${parent.id}`)).toMatchObject({ closed: true, activeRunId: null })
    await request('POST', `/plan/sessions/${parent.id}/messages`, { text: 'Read the latest findings' })
    const reopened = (await runner.next('run.assign', m => m.job.planSessionId === parent.id)).job
    expect(reopened.prompt).toContain(child.id)
    expect(reopened.prompt).toContain('finished its turn')
    await finish(reopened, 'Findings received.')
    await request('POST', `/plan/sessions/${parent.id}/messages`, { text: 'Continue without repeating old notices' })
    const next = (await runner.next('run.assign', m => m.job.planSessionId === parent.id)).job
    expect(next.prompt).not.toContain('finished its turn')
    expect(next.prompt).not.toContain('was stopped')
    evidence.push({ event: 'second warm parent turn prompt', prompt: next.prompt })
    await finish(next, 'No new notices.')
  })
  it('refuses an unrelated human thread close without changing its plan or Draft tasks', async () => {
    const target = await request('POST', '/plan/sessions', { projectId: child.projectId, text: 'Plan human-owned work' }) as PlanSessionDetail
    const targetJob = (await runner.next('run.assign', m => m.job.planSessionId === target.id)).job
    await call(targetJob, 'propose_plan', { title: 'Human-owned plan', tasks: [{ key: 'safe', title: 'Preserve this Draft', type: 'task', description: 'Await human approval', acceptanceCriteria: ['The work remains available'] }] })
    await finish(targetJob, 'Waiting for your approval.')
    const unrelated = await request('POST', '/plan/sessions', { text: 'Inspect another conversation' }) as PlanSessionDetail
    const caller = (await runner.next('run.assign', m => m.job.planSessionId === unrelated.id)).job
    const before = await request('GET', `/plan/sessions/${target.id}`) as PlanSessionDetail
    const refused = await runner.call(caller.runId, caller.leaseEpoch, 'close_thread', { threadId: target.id })
    evidence.push({ transport: 'runner WebSocket', tool: 'close_thread', input: { threadId: target.id }, response: refused })
    expect(refused).toMatchObject({ ok: false, error: expect.stringContaining('Ask the human') })
    expect(await request('GET', `/plan/sessions/${target.id}`)).toEqual(before)
    const [draft] = await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, before.plans[0]!.tasks[0]!.taskId!))
    expect(draft).toMatchObject({ status: 'draft', deletedAt: null })
    await request('POST', `/plan/sessions/${target.id}/close`)
    expect(await request('GET', `/plan/sessions/${target.id}`)).toMatchObject({ closed: true, plans: [{ status: 'discarded' }] })
    await finish(caller, 'The human must confirm that close.')
  })

  it('notifies on explicit stop and kill switch exactly once without resurfacing a read parent reply', async () => {
    const coordinator = await request('POST', '/plan/sessions', { text: 'Coordinate stop checks' }) as PlanSessionDetail
    let job = (await runner.next('run.assign', m => m.job.planSessionId === coordinator.id)).job
    const stopped = await call<PlanSessionDetail>(job, 'start_thread', { title: 'Stop helper', message: 'Wait for instructions' })
    const stoppedJob = (await runner.next('run.assign', m => m.job.planSessionId === stopped.id)).job
    await finish(job, 'Parent reply already seen.')
    await request('POST', `/plan/sessions/${coordinator.id}/read`)
    const before = await request('GET', '/inbox') as Inbox
    expect(before.needsYou.some(i => i.type === 'plan_thread' && i.sessionId === coordinator.id)).toBe(false)
    await t.orchestrator.stopRun(stoppedJob.runId, t.actor)
    const stopping = await runner.next('run.stop', m => m.runId === stoppedJob.runId)
    evidence.push({ event: 'explicit stop', response: stopping })
    runner.send({ type: 'run.ended', runId: stoppedJob.runId, leaseEpoch: stoppedJob.leaseEpoch, exit: { kind: 'stopped' }, headSha: null })
    await sleep(50)
    const detail = await request('GET', `/plan/sessions/${coordinator.id}`) as PlanSessionDetail
    expect(detail.unread).toBe(false)
    expect(detail.messages.filter(m => m.senderSessionId === stopped.id)).toMatchObject([{ text: 'Thread “Stop helper” was stopped.' }])
    const after = await request('GET', '/inbox') as Inbox
    expect(after.needsYou.some(i => i.type === 'plan_thread' && i.sessionId === coordinator.id)).toBe(false)
    expect(after.count).toBe(before.count)
    await request('POST', `/plan/sessions/${coordinator.id}/messages`, { text: 'Check kill switch' })
    job = (await runner.next('run.assign', m => m.job.planSessionId === coordinator.id)).job
    const killed = await call<PlanSessionDetail>(job, 'start_thread', { title: 'Kill switch helper', message: 'Wait for instructions' })
    await runner.next('run.assign', m => m.job.planSessionId === killed.id)
    await t.orchestrator.stopAll(t.actor)
    const closed = await request('GET', `/plan/sessions/${coordinator.id}`) as PlanSessionDetail
    expect(closed.messages.filter(m => m.senderSessionId === killed.id)).toMatchObject([{ text: 'Thread “Kill switch helper” was stopped.' }])
    await t.orchestrator.resumeAll(t.actor)
  })

  it('audits successful thread actions under their target project, including Global targets from a project sender', async () => {
    const rows = (await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'pm.tool_called')))
      .map(r => ({ ...r, detail: r.detail as { tool: string, ok: boolean, sessionId: string } }))
    for (const tool of ['start_thread', 'read_thread', 'message_thread', 'close_thread']) {
      expect(rows.some(r => r.detail.tool === tool && r.detail.ok === true && r.projectId === child.projectId)).toBe(true)
    }
    await request('POST', `/plan/sessions/${child.id}/messages`, { text: 'Check global attribution' })
    const job = (await runner.next('run.assign', m => m.job.planSessionId === child.id)).job
    const global = await call<PlanSessionDetail>(job, 'start_thread', { title: 'Global audit helper', message: 'Check global state' })
    const globalJob = (await runner.next('run.assign', m => m.job.planSessionId === global.id)).job
    await finish(globalJob, 'Global state checked.')
    await call(job, 'read_thread', { threadId: global.id })
    await call(job, 'message_thread', { threadId: global.id, message: 'Check again' })
    await runner.next('run.assign', m => m.job.planSessionId === global.id)
    await call(job, 'close_thread', { threadId: global.id })
    const globalAudit = (await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'pm.tool_called')))
      .map(r => ({ ...r, detail: r.detail as { tool: string, ok: boolean, sessionId: string } }))
    const actions = globalAudit.filter(r => r.detail.sessionId === child.id && r.detail.ok === true)
    expect(actions.map(r => r.detail.tool)).toEqual(['start_thread', 'read_thread', 'message_thread', 'close_thread'])
    expect(actions.every(r => r.projectId === null)).toBe(true)
    evidence.push({ event: 'target-project audit records', records: globalAudit.filter(r => ['start_thread', 'read_thread', 'message_thread', 'close_thread'].includes(String(r.detail.tool))) })
    await finish(job, 'Audit checks complete.')
  })
})
