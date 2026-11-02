import type { Inbox, RunJob, TaskInboxItem } from '@corral/contracts'
import { schema } from '@corral/db'
import { databaseFixture } from '@corral/db/testing'
import { asc, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { RUNNER_RESTARTED } from './run-context.ts'
import { FakeRunner } from './test-runner.ts'

const { tasks, runs, agents } = schema

describe.each(['pglite', 'postgres'] as const)('no-progress recovery on %s', (driver) => {
  let t: TestApp
  let runner: FakeRunner
  databaseFixture(driver, async () => {
    t = await createTestApp(driver, { listen: true })
    runner = await FakeRunner.connect(t.server!.url, [], 'recovery', { slots: 50 })
    await t.db.update(agents).set({ concurrency: 50 })
  })
  afterAll(async () => {
    runner?.close()
    await t?.close()
  })
  const row = async (id: string) => (await t.db.select().from(tasks).where(eq(tasks.id, id)))[0]!
  async function assigned(cap = 3) {
    const project = await t.createProject()
    await t.request('PATCH', `/api/projects/${project.slug}`, { failedRunCap: cap })
    const task = await t.createTask(project.slug)
    await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
    await t.orchestrator.schedule()
    const job = (await runner.next('run.assign', m => m.job.taskId === task.id)).job
    return { project, task, job }
  }
  async function fail(job: RunJob, head = 'target-tip') {
    expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'failed', summary: 'Cannot implement this unchanged', note: 'Investigated; no changes', headSha: head })).toMatchObject({ ok: true })
    await t.orchestrator.schedule()
  }
  async function stopped() {
    const setup = await assigned()
    await fail(setup.job)
    const second = (await runner.next('run.assign', m => m.job.taskId === setup.task.id)).job
    await fail(second)
    const stop = (await row(setup.task.id)).retryStop!
    expect(stop).toMatchObject({ capped: false, sessionId: expect.any(String) })
    const pm = (await runner.next('run.assign', m => m.job.planSessionId === stop.sessionId)).job
    return { ...setup, pm, stop }
  }
  const mine = async (projectId: string) => (await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox).needsYou.filter(i => i.project.id === projectId)
  const act = (taskId: string, input: object) => t.request('POST', `/api/inbox/${taskId}/actions`, input)

  it('stops after two unchanged failures, persists one visible PM turn and resumes on a target change', async () => {
    const { task, project, pm } = await stopped()
    for (let i = 0; i < 3; i++) await t.orchestrator.schedule()
    const history = await t.db.select().from(runs).where(eq(runs.taskId, task.id)).orderBy(asc(runs.number))
    expect(history.map(r => r.role)).toEqual(['developer', 'developer', 'pm'])
    // Stopping triage must not be mistaken for new human task input or
    // cause another automatic PM turn for this episode.
    await t.request('POST', `/api/runs/${pm.runId}/stop`)
    await t.orchestrator.schedule()
    expect((await row(task.id)).retryStop).not.toBeNull()
    expect((await t.db.select().from(runs).where(eq(runs.taskId, task.id))).filter(r => r.role === 'pm')).toHaveLength(1)
    expect(pm.prompt).toContain('Read get_task, list_runs and get_run')
    expect(pm.prompt).toContain('propose concrete follow-up work')
    expect(await mine(task.projectId)).toMatchObject([{ id: task.id, type: 'stopped' }])
    t.clock.now = new Date(t.clock.now.getTime() + 6 * 60_000)
    t.github.setBranch(project.repository, 'main', 'changed-target')
    await t.orchestrator.schedule()
    const resumed = (await runner.next('run.assign', m => m.job.taskId === task.id)).job
    expect(resumed.role).toBe('developer')
    expect((await row(task.id)).retryStop).toBeNull()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  })

  it('keeps the PM triage lease independent when resumed worker work expires', async () => {
    const { task, project, pm } = await stopped()
    t.clock.now = new Date(t.clock.now.getTime() + 6 * 60_000)
    t.github.setBranch(project.repository, 'main', 'new-target')
    await t.orchestrator.schedule()
    await runner.next('run.assign', m => m.job.taskId === task.id)
    const expired = new Date(t.clock.now.getTime() - 1000)
    await t.db.update(tasks).set({ leaseExpiresAt: expired }).where(eq(tasks.id, task.id))
    await t.db.update(runs).set({ leaseExpiresAt: expired }).where(eq(runs.id, pm.runId))
    await t.orchestrator.onHeartbeat([{ runId: pm.runId, leaseEpoch: pm.leaseEpoch }], 'recovery', t.clock.now.getTime())
    const [renewed] = await t.db.select().from(runs).where(eq(runs.id, pm.runId))
    expect(renewed!.leaseExpiresAt!.getTime()).toBeGreaterThan(t.clock.now.getTime())
    expect((await row(task.id)).leaseExpiresAt).toEqual(expired)
  })

  it('lets PM comment on implementation recovery without a human question', async () => {
    const { task, pm } = await stopped()
    expect(await runner.call(pm.runId, pm.leaseEpoch, 'get_task', { taskRef: task.ref })).toMatchObject({ ok: true })
    expect(await runner.call(pm.runId, pm.leaseEpoch, 'add_comment', { taskRef: task.ref, body: 'The parser uses the wrong field; propose a fix to read targetBranch before retrying.' })).toMatchObject({ ok: true })
    expect(await mine(task.projectId)).toEqual([])
    await finishPm(pm)
    for (let i = 0; i < 3; i++) await t.orchestrator.schedule()
    expect(await row(task.id)).toMatchObject({ status: 'in_progress', leaseRunId: null, retryStop: { capped: false } })
    const items = await mine(task.projectId)
    expect(items).toMatchObject([{ id: task.id, taskId: task.id, type: 'stopped', body: expect.stringContaining('The parser uses the wrong field') }])
    expect(items).toHaveLength(1)
    expect(items[0]).toMatchObject({ body: expect.stringContaining('Blocked: Two consecutive failures') })
    expect(items[0]).toMatchObject({ body: expect.stringContaining('Decision needed: retry, give the developer new direction') })
    expect(items[0]).toMatchObject({ body: expect.stringContaining('Recommendation: address the PM findings') })
    expect((await t.db.select().from(runs).where(eq(runs.taskId, task.id)).orderBy(asc(runs.number))).map(r => r.role)).toEqual(['developer', 'developer', 'pm'])
  })

  it('says triage found nothing when no PM comment exists, and ignores findings from an earlier stop', async () => {
    const first = await stopped()
    expect(await runner.call(first.pm.runId, first.pm.leaseEpoch, 'add_comment', { taskRef: first.task.ref, body: 'Findings from the first stop.' })).toMatchObject({ ok: true })
    await finishPm(first.pm)
    expect((await act(first.task.id, { action: 'retry' })).status).toBe(200)
    await t.request('PATCH', `/api/projects/${first.project.slug}`, { failedRunCap: 9 })
    await t.orchestrator.schedule()
    await fail((await runner.next('run.assign', m => m.job.taskId === first.task.id)).job)
    await fail((await runner.next('run.assign', m => m.job.taskId === first.task.id)).job)
    const stop = (await row(first.task.id)).retryStop!
    expect(stop.sessionId).not.toBe(first.stop.sessionId)
    await finishPm((await runner.next('run.assign', m => m.job.planSessionId === stop.sessionId)).job, 'Nothing to add.')
    const [item] = await mine(first.project.id) as TaskInboxItem[]
    expect(item).toMatchObject({ type: 'stopped', body: expect.stringContaining('PM triage produced no findings.') })
    expect(item!.body).toContain('Recommendation: review the failed runs')
    expect(item!.body).not.toContain('Findings from the first stop')
    expect(item!.body).not.toContain('address the PM findings')
  })

  it('keeps a stopped task in Needs you when triage fails', async () => {
    const { task, pm, stop } = await stopped()
    runner.send({ type: 'run.ended', runId: pm.runId, leaseEpoch: pm.leaseEpoch, exit: { kind: 'exited', code: 1 }, headSha: null })
    await expect.poll(async () => (await t.db.select().from(runs).where(eq(runs.id, pm.runId)))[0]!.state).toBe('failed')
    await t.orchestrator.schedule()
    const items = await mine(task.projectId)
    expect(items.map(i => i.id).sort()).toEqual([stop.sessionId, task.id].sort())
    expect(items.find(i => i.id === task.id)).toMatchObject({ type: 'stopped', body: expect.stringContaining('PM triage produced no findings.') })
  })

  async function stoppedInReview() {
    const { task, project, job } = await assigned(6)
    t.github.setBranch(project.repository, job.branch!, 'reviewed-head')
    for (const c of task.acceptanceCriteria) await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', { criterionId: c.id, kind: 'note', note: 'Evidence' })
    expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', summary: 'Done', note: 'Opened the PR', headSha: 'reviewed-head' }))
      .toMatchObject({ ok: true })
    await t.orchestrator.schedule()
    const reviewers: RunJob[] = []
    for (let attempt = 0; attempt < 2; attempt++) {
      const reviewer = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'reviewer')).job
      reviewers.push(reviewer)
      runner.send({ type: 'run.ended', runId: reviewer.runId, leaseEpoch: reviewer.leaseEpoch, exit: { kind: 'exited', code: 1 }, headSha: reviewer.headSha })
      await expect.poll(async () => (await t.db.select().from(runs).where(eq(runs.id, reviewer.runId)))[0]!.state).toBe('failed')
      await t.orchestrator.schedule()
    }
    const stop = (await row(task.id)).retryStop!
    expect(stop).toMatchObject({ status: 'agent_review', sessionId: expect.any(String) })
    await finishPm((await runner.next('run.assign', m => m.job.planSessionId === stop.sessionId)).job)
    return { task, project }
  }

  it('lists an agent_review stop and retries the reviewer without moving its status', async () => {
    const { task, project } = await stoppedInReview()
    expect(await mine(project.id)).toMatchObject([{ id: task.id, type: 'stopped', body: expect.stringContaining('PM triage produced no findings.') }])
    const failedRuns = (await row(task.id)).failedRuns
    expect((await act(task.id, { action: 'retry' })).status).toBe(200)
    expect(await row(task.id)).toMatchObject({ status: 'agent_review', failedRuns, retryStop: null })
    expect((await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'reviewer' && m.job.runId !== undefined)).job.role).toBe('reviewer')
    expect(await mine(project.id)).toEqual([])
    const resolved = (await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox).resolved
    expect(resolved.find(i => i.taskId === task.id)?.resolution).toBe('You restarted the stopped task')
  })

  it('sends a stopped task back to the Backlog', async () => {
    const { task, pm } = await stopped()
    await finishPm(pm)
    expect((await act(task.id, { action: 'send_back' })).status).toBe(200)
    expect(await row(task.id)).toMatchObject({ status: 'backlog', retryStop: null })
    await t.orchestrator.schedule()
    expect(await mine(task.projectId)).toEqual([])
    expect((await t.db.select().from(runs).where(eq(runs.taskId, task.id)).orderBy(asc(runs.number))).map(r => r.role)).toEqual(['developer', 'developer', 'pm'])
  })

  it('carries a stopped task on with human direction, leaving the failed-run counter alone', async () => {
    const { task, pm } = await stopped()
    await finishPm(pm)
    const { failedRuns } = await row(task.id)
    expect((await act(task.id, { action: 'clarify', text: 'Read the configured target branch instead.' })).status).toBe(200)
    expect(await row(task.id)).toMatchObject({ status: 'in_progress', failedRuns, retryStop: null })
    await t.orchestrator.schedule()
    expect((await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'developer')).job.prompt).toBeDefined()
  })

  it('refuses retry and the status menu on a task that is not stopped', async () => {
    const { task, project } = await assigned()
    expect((await act(task.id, { action: 'retry' })).status).toBe(409)
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'release_stop', to: null })).status).toBe(400)
  })

  it('shows a structured PM question in Needs you and resumes after the human answers', async () => {
    const { task, pm, stop } = await stopped()
    const question = { question: 'Blocked: the repository is archived. Recovery cannot write to it. Decision: unarchive or move the work?', recommendation: 'Unarchive the test repository and retry.', options: ['Unarchive and retry', 'Cancel the work'], retryOptions: ['Unarchive and retry'] }
    expect(await runner.call(pm.runId, pm.leaseEpoch, 'ask_question', question)).toMatchObject({ ok: true })
    const inbox = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    expect(inbox.needsYou.find(i => i.id === stop.sessionId)).toMatchObject({ question: expect.objectContaining({ text: question.question, recommendation: question.recommendation }) })
    runner.send({ type: 'run.events', runId: pm.runId, leaseEpoch: pm.leaseEpoch, events: [{ type: 'message', text: 'Waiting for your recovery decision.' }] })
    runner.send({ type: 'run.ended', runId: pm.runId, leaseEpoch: pm.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
    // Wait for the server to finish the PM turn before answering.
    await expect.poll(async () => (await t.db.select().from(runs).where(eq(runs.id, pm.runId)))[0]!.state).toBe('completed')
    expect((await t.request('POST', `/api/plan/sessions/${stop.sessionId}/messages`, { text: 'Unarchive and retry' })).status).toBe(201)
    await t.orchestrator.schedule()
    expect((await runner.next('run.assign', m => m.job.taskId === task.id)).job.role).toBe('developer')
  })

  async function finishPm(pm: RunJob, text = 'PM findings are on the task; no plan or question.') {
    runner.send({ type: 'run.events', runId: pm.runId, leaseEpoch: pm.leaseEpoch, events: [{ type: 'message', text }] })
    runner.send({ type: 'run.ended', runId: pm.runId, leaseEpoch: pm.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
    await expect.poll(async () => (await t.db.select().from(runs).where(eq(runs.id, pm.runId)))[0]!.state).toBe('completed')
  }

  it('resolves a cap only after an explicitly authorized pending retry choice', async () => {
    const { task, job } = await assigned(1)
    await fail(job)
    const stop = (await row(task.id)).retryStop!
    const pm = (await runner.next('run.assign', m => m.job.planSessionId === stop.sessionId)).job
    expect(await runner.call(pm.runId, pm.leaseEpoch, 'ask_question', { question: 'Blocked by exhausted recovery. Retry after the repair?', options: ['Retry', 'Leave stopped'], retryOptions: ['Retry'] })).toMatchObject({ ok: true })
    await finishPm(pm)
    expect((await t.request('POST', `/api/plan/sessions/${stop.sessionId}/messages`, { text: 'Retry' })).status).toBe(201)
    await t.orchestrator.schedule()
    expect(await row(task.id)).toMatchObject({ status: 'in_progress', failedRuns: 0, retryStop: null })
    expect((await runner.next('run.assign', m => m.job.taskId === task.id)).job.role).toBe('developer')
  })

  it.each(['Leave stopped', 'Why did it fail?'])('keeps capped work stopped when the human says %s', async (text) => {
    const { task, job } = await assigned(1)
    await fail(job)
    const stop = (await row(task.id)).retryStop!
    const pm = (await runner.next('run.assign', m => m.job.planSessionId === stop.sessionId)).job
    expect(await runner.call(pm.runId, pm.leaseEpoch, 'ask_question', { question: 'Blocked by exhausted recovery. Decision: retry or leave stopped?', recommendation: 'Retry', options: ['Retry', 'Leave stopped'], retryOptions: ['Retry'] })).toMatchObject({ ok: true })
    await finishPm(pm)
    expect((await t.request('POST', `/api/plan/sessions/${stop.sessionId}/messages`, { text })).status).toBe(201)
    await t.orchestrator.schedule()
    expect(await row(task.id)).toMatchObject({ status: 'failed', failedRuns: 1, retryStop: { runId: job.runId } })
    expect((await t.db.select().from(runs).where(eq(runs.taskId, task.id))).filter(r => r.role === 'developer')).toHaveLength(1)
    const continuation = (await runner.next('run.assign', m => m.job.planSessionId === stop.sessionId)).job
    expect((await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox).needsYou.filter(i => i.project.id === task.projectId)).toMatchObject([{ id: task.id, type: 'failed' }])
    await finishPm(continuation)
    expect((await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox).needsYou.filter(i => i.project.id === task.projectId)).toMatchObject([{ id: task.id, type: 'failed' }])
    // A matching word after the pending question has been answered is not authorization.
    expect((await t.request('POST', `/api/plan/sessions/${stop.sessionId}/messages`, { text: 'Retry' })).status).toBe(201)
    expect((await row(task.id)).status).toBe('failed')
  })

  it.each(['capped', 'stuck'] as const)('returns unresolved %s work to Needs you after comment-only triage', async (kind) => {
    const { task, job } = await assigned(1)
    if (kind === 'capped') await fail(job)
    else {
      expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'stuck', note: 'Need a format decision', summary: 'CSV or JSON?' })).toMatchObject({ ok: true })
      await t.orchestrator.schedule()
    }
    const stop = (await row(task.id)).retryStop!
    if (kind === 'capped') {
      const transitions = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.taskId, task.id)).orderBy(asc(schema.auditLog.id))
      const entered = transitions.find(entry => entry.action === 'task.transition' && (entry.detail as { to?: string }).to === 'failed')!
      await t.db.insert(schema.inboxMessages).values({ arrival: `${task.id}:failed:audit-${entered.id}`, message: 'No findings were recorded.' })
    }
    const pm = (await runner.next('run.assign', m => m.job.planSessionId === stop.sessionId)).job
    const findings = 'The parser supports both formats. Resolve the format requirement before another attempt.'
    expect(await runner.call(pm.runId, pm.leaseEpoch, 'add_comment', { taskRef: task.ref, body: findings })).toMatchObject({ ok: true })
    expect((await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox).needsYou.filter(i => i.project.id === task.projectId)).toEqual([])
    await finishPm(pm)
    for (let i = 0; i < 2; i++) {
      await t.orchestrator.schedule()
      const mine = (await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox).needsYou.filter(i => i.project.id === task.projectId)
      expect(mine).toMatchObject([{ id: task.id, taskId: task.id, type: kind === 'capped' ? 'failed' : 'question', body: expect.stringContaining(findings) }])
      expect(mine).toHaveLength(1)
      expect(mine[0]).toMatchObject({ body: expect.stringContaining('Decision needed:') })
      expect(mine[0]).toMatchObject({ body: expect.stringContaining('Recommendation:'), message: expect.stringContaining('The parser supports both formats') })
    }
    expect((await t.db.select().from(runs).where(eq(runs.taskId, task.id))).filter(r => r.role === 'pm')).toHaveLength(1)
  })

  it('keeps a pending follow-up plan actionable instead of duplicating its capped task', async () => {
    const { task, job } = await assigned(1)
    await fail(job)
    const stop = (await row(task.id)).retryStop!
    const pm = (await runner.next('run.assign', m => m.job.planSessionId === stop.sessionId)).job
    expect(await runner.call(pm.runId, pm.leaseEpoch, 'propose_plan', { title: 'Repair the parser', summary: 'Fix the implementation before retrying.', tasks: [{ key: 'parser', title: 'Repair the parser', type: 'bug', description: 'Read the configured target branch.', acceptanceCriteria: ['Reads the configured target branch.'] }] })).toMatchObject({ ok: true })
    await finishPm(pm)
    const mine = (await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox).needsYou.filter(i => i.project.id === task.projectId)
    expect(mine).toMatchObject([{ id: stop.sessionId, type: 'plan_thread', status: 'needs_approval' }])
    expect(mine).toHaveLength(1)
    expect(await row(task.id)).toMatchObject({ status: 'failed', failedRuns: 1, retryStop: { runId: job.runId } })
  })

  it('does not triage historic capped tasks just because the scheduler starts', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    await t.db.update(tasks).set({ status: 'failed', statusReason: 'Failed-run cap reached (3)', failedRuns: 3 }).where(eq(tasks.id, task.id))
    await t.orchestrator.schedule()
    expect((await row(task.id)).retryStop).toBeNull()
    expect(await t.db.select().from(runs).where(eq(runs.taskId, task.id))).toEqual([])
    expect((await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox).needsYou.filter(i => i.project.id === project.id)).toMatchObject([{ id: task.id, type: 'failed' }])
  })

  it('records a new cap reached by a reconnected exit and triages it once', async () => {
    const { project, task, job } = await assigned(1)
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    await t.db.update(runs).set({ state: 'interrupted', endedAt: t.clock.now, error: RUNNER_RESTARTED }).where(eq(runs.id, job.runId))
    await t.db.update(tasks).set({ leaseRunId: null, leaseRole: null, leaseExpiresAt: null, leaseHeartbeatAt: null }).where(eq(tasks.id, task.id))
    await t.orchestrator.onRunMessage({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 1 }, headSha: null }, 'recovery')
    await t.orchestrator.schedule()
    expect(await row(task.id)).toMatchObject({ status: 'failed', failedRuns: 1, retryStop: { capped: true, sessionId: expect.any(String) } })
    await t.orchestrator.schedule()
    expect((await t.db.select().from(runs).where(eq(runs.taskId, task.id))).filter(r => r.role === 'pm')).toHaveLength(1)
  })

  it('backs off unchanged-target polling while human task input remains immediate', async () => {
    const { task, project } = await stopped()
    await t.orchestrator.schedule()
    const polls = () => t.github.calls.filter(call => call.method === 'branchHead' && call.args[0] === project.repository).length
    const before = polls()
    for (let i = 0; i < 5; i++) await t.orchestrator.schedule()
    expect(polls()).toBe(before)
    t.clock.now = new Date(t.clock.now.getTime() + 61_000)
    await t.orchestrator.schedule()
    expect(polls()).toBe(before + 1)
    t.clock.now = new Date(t.clock.now.getTime() + 61_000)
    await t.orchestrator.schedule()
    expect(polls()).toBe(before + 1)
    await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/comments`, { body: 'Use the alternative implementation.' })
    await t.orchestrator.schedule()
    expect((await row(task.id)).retryStop).toBeNull()
  })

  it('releases repetition on new human task input and starts a fresh streak', async () => {
    const { task, project } = await stopped()
    await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/comments`, { body: 'Use the documented alternative implementation.' })
    await t.orchestrator.schedule()
    const resumed = (await runner.next('run.assign', m => m.job.taskId === task.id)).job
    expect(resumed.role).toBe('developer')
    expect((await row(task.id)).retryStop).toBeNull()
    await t.request('PATCH', `/api/projects/${project.slug}`, { failedRunCap: 6 })
    await fail(resumed)
    expect((await row(task.id)).retryStop).toBeNull()
  })

  it('does not mistake a changed head or input during a run for repetition', async () => {
    const { task, project, job } = await assigned(6)
    await fail(job, 'changed-head')
    const second = (await runner.next('run.assign', m => m.job.taskId === task.id)).job
    await fail(second)
    expect((await row(task.id)).retryStop).toBeNull()
    const third = (await runner.next('run.assign', m => m.job.taskId === task.id)).job
    await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/comments`, { body: 'New information while the run is active.' })
    await fail(third)
    expect((await row(task.id)).retryStop).toBeNull()
  })

  it('measures a kept local commit from the runner checkout rather than the remote branch', async () => {
    const { task, job } = await assigned(6)
    await fail(job, 'local-progress')
    for (let attempt = 0; attempt < 2; attempt++) {
      const next = (await runner.next('run.assign', m => m.job.taskId === task.id)).job
      runner.send({ type: 'run.started', runId: next.runId, leaseEpoch: next.leaseEpoch, agentSessionId: 'local-session', initialHeadSha: 'local-progress' })
      await expect.poll(async () => (await t.db.select().from(runs).where(eq(runs.id, next.runId)))[0]!.retryContext?.head).toBe('local-progress')
      await fail(next, 'local-progress')
      expect(Boolean((await row(task.id)).retryStop)).toBe(attempt === 1)
    }
  })

  it('routes a developer stuck report to PM before asking the human', async () => {
    const { task, job } = await assigned()
    expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'stuck', note: 'Diagnosed the parser', summary: 'The parser reads the wrong field; implementation follow-up needed.' })).toMatchObject({ ok: true })
    await t.orchestrator.schedule()
    const taskRow = await row(task.id)
    expect(taskRow).toMatchObject({ status: 'blocked', retryStop: { sessionId: expect.any(String) } })
    const pm = (await runner.next('run.assign', m => m.job.planSessionId === taskRow.retryStop!.sessionId)).job
    expect(pm.prompt).toContain('Do not ask the human to debug')
    expect((await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox).needsYou.some(i => i.taskId === task.id)).toBe(false)
  })

  it('triages the failed-run cap exactly once even without a known head', async () => {
    const { task, project, job } = await assigned(1)
    await fail(job, 'new-head')
    expect(await row(task.id)).toMatchObject({ status: 'failed', failedRuns: 1, retryStop: { capped: true, sessionId: expect.any(String) } })
    await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/comments`, { body: 'Looking at this failure.' })
    t.github.setBranch(project.repository, 'main', 'changed-at-cap')
    await t.orchestrator.schedule()
    await t.orchestrator.schedule()
    expect((await row(task.id)).status).toBe('failed')
    expect((await t.db.select().from(runs).where(eq(runs.taskId, task.id))).filter(r => r.role === 'pm')).toHaveLength(1)
  })

  it('also stops ordinary process failures when both unchanged heads are known', async () => {
    const { task, job } = await assigned(6)
    let current = job
    for (let attempt = 0; attempt < 2; attempt++) {
      runner.send({ type: 'run.ended', runId: current.runId, leaseEpoch: current.leaseEpoch, exit: { kind: 'exited', code: 1 }, headSha: 'target-tip' })
      await expect.poll(async () => (await t.db.select().from(runs).where(eq(runs.id, current.runId)))[0]!.state).toBe('failed')
      await t.orchestrator.schedule()
      if (!attempt) current = (await runner.next('run.assign', m => m.job.taskId === task.id)).job
    }
    expect((await row(task.id)).retryStop).toMatchObject({ sessionId: expect.any(String), capped: false })
  })

  it.each(['rate_limited', 'stopped', 'error'] as const)('%s breaks the no-progress streak without bypassing recovery', async (kind) => {
    const { task, job } = await assigned(6)
    await fail(job)
    const next = (await runner.next('run.assign', m => m.job.taskId === task.id)).job
    const exit = kind === 'rate_limited' ? { kind, resetsAt: new Date(t.clock.now.getTime() - 1000).toISOString() } : kind === 'error' ? { kind, message: 'Connection dropped' } : { kind }
    runner.send({ type: 'run.ended', runId: next.runId, leaseEpoch: next.leaseEpoch, exit, headSha: 'target-tip' })
    await expect.poll(async () => (await t.db.select().from(runs).where(eq(runs.id, next.runId)))[0]!.state).not.toBe('queued')
    await t.orchestrator.schedule()
    const third = (await runner.next('run.assign', m => m.job.taskId === task.id)).job
    await fail(third)
    expect((await row(task.id)).retryStop).toBeNull()
    expect((await runner.next('run.assign', m => m.job.taskId === task.id)).job.role).toBe('developer')
  })
})
