import type { Inbox, RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { databaseFixture } from '@corral/db/testing'
import { asc, eq } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
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
    expect((await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox).needsYou.some(i => i.taskId === task.id)).toBe(false)
    t.github.setBranch(project.repository, 'main', 'changed-target')
    await t.orchestrator.schedule()
    const resumed = (await runner.next('run.assign', m => m.job.taskId === task.id)).job
    expect(resumed.role).toBe('developer')
    expect((await row(task.id)).retryStop).toBeNull()
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  })

  it('keeps the PM triage lease independent when resumed worker work expires', async () => {
    const { task, project, pm } = await stopped()
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
    expect((await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox).needsYou.some(i => i.project.id === task.projectId)).toBe(false)
  })

  it('shows a structured PM question in Needs you and resumes after the human answers', async () => {
    const { task, pm, stop } = await stopped()
    const question = { question: 'Blocked: the repository is archived. Recovery cannot write to it. Decision: unarchive or move the work?', recommendation: 'Unarchive the test repository and retry.', options: ['Unarchive and retry', 'Cancel the work'] }
    expect(await runner.call(pm.runId, pm.leaseEpoch, 'ask_question', question)).toMatchObject({ ok: true })
    const inbox = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    expect(inbox.needsYou.find(i => i.id === stop.sessionId)).toMatchObject({ question: expect.objectContaining({ text: question.question, recommendation: question.recommendation }) })
    runner.send({ type: 'run.events', runId: pm.runId, leaseEpoch: pm.leaseEpoch, events: [{ type: 'message', text: 'Waiting for your recovery decision.' }] })
    runner.send({ type: 'run.ended', runId: pm.runId, leaseEpoch: pm.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
    // Wait for the server to finish the PM turn before answering.
    await expect.poll(async () => (await t.db.select().from(runs).where(eq(runs.id, pm.runId)))[0]!.state).toBe('completed')
    expect((await t.request('POST', `/api/plan/sessions/${stop.sessionId}/messages`, { text: 'Unarchived; retry now.' })).status).toBe(201)
    await t.orchestrator.schedule()
    expect((await runner.next('run.assign', m => m.job.taskId === task.id)).job.role).toBe('developer')
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
