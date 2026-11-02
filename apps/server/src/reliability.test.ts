import { RUNNER_HEARTBEAT_MS, type PlanSessionDetail, type RunnerMessage } from '@corral/contracts'
import { LEASE_DURATION_MS } from '@corral/core'
import { schema } from '@corral/db'
import { and, eq, ne } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'

const { agents, projects, runs, tasks } = schema

// What keeps the server up and its passes moving when one piece fails
describe('server reliability', () => {
  let t: TestApp
  let runner: FakeRunner

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    await t.db.update(agents).set({ concurrency: 50 }).where(ne(agents.role, 'pm'))
    runner = await FakeRunner.connect(t.server!.url)
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function approved() {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
    return { project, task }
  }

  it('survives a failed lease sweep and still runs the merge and scheduling passes', async () => {
    vi.spyOn(t.orchestrator, 'sweepLeases').mockRejectedValueOnce(new Error('connection terminated'))
    const merges = vi.spyOn(t.orchestrator.merges, 'tick')
    const scheduling = vi.spyOn(t.orchestrator, 'schedule')
    await expect(t.orchestrator.tick()).resolves.toBeUndefined()
    expect(merges).toHaveBeenCalledOnce()
    expect(scheduling).toHaveBeenCalledOnce()
  })

  it('runs one tick at a time', async () => {
    let finish = () => {}
    const sweep = vi.spyOn(t.orchestrator, 'sweepLeases').mockImplementation(() => new Promise<void>((resolve) => {
      finish = resolve
    }))
    const first = t.orchestrator.tick()
    const second = t.orchestrator.tick()
    expect(sweep).toHaveBeenCalledOnce()
    finish()
    await Promise.all([first, second])
  })

  it('drops silent runners even while a slow tick is running', async () => {
    let finish = () => {}
    vi.spyOn(t.orchestrator, 'sweepLeases').mockImplementation(() => new Promise<void>((resolve) => {
      finish = resolve
    }))
    const dropped = vi.spyOn(t.runner, 'dropSilent')
    const first = t.orchestrator.tick()
    const second = t.orchestrator.tick()
    expect(dropped).toHaveBeenCalledTimes(2)
    finish()
    await Promise.all([first, second])
  })

  async function assigned() {
    const { project, task } = await approved()
    await t.orchestrator.schedule()
    const { job } = await runner.next('run.assign', m => m.job.taskId === task.id)
    return { project, task, job }
  }

  const run = async (id: string) => (await t.db.select().from(runs).where(eq(runs.id, id)))[0]!
  const task = async (id: string) => (await t.db.select().from(tasks).where(eq(tasks.id, id)))[0]!
  const later = (ms: number) => {
    t.clock.now = new Date(t.clock.now.getTime() + ms)
  }

  describe('a run.ended replayed after reconnecting', () => {
    const lost = (job: { runId: string }) => expect.poll(async () => (await run(job.runId)).state).toBe('interrupted')
    const ended = (job: { runId: string, leaseEpoch: number }, exit: Extract<RunnerMessage, { type: 'run.ended' }>['exit'], extra = {}) =>
      runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit, headSha: null, ...extra })

    it('restores a usage limit, so the agent pauses instead of retrying into it', async () => {
      const { project, job } = await assigned()
      await t.orchestrator.onConnected([], 'r1')
      await lost(job)
      const resetsAt = new Date(t.clock.now.getTime() + 3_600_000).toISOString()
      ended(job, { kind: 'rate_limited', resetsAt })
      await expect.poll(async () => (await run(job.runId)).state).toBe('completed')
      expect(await run(job.runId)).toMatchObject({ outcome: 'rate_limited', error: null, rateLimitResetAt: new Date(resetsAt) })
      const [developer] = await t.db.select().from(agents).where(eq(agents.role, 'developer'))
      expect(developer!.pausedUntil).toEqual(new Date(resetsAt))
      await t.db.update(agents).set({ pausedUntil: null }).where(eq(agents.role, 'developer'))
      await t.db.update(projects).set({ paused: true }).where(eq(projects.id, project.id))
    })

    it('keeps the commit that saved the work, for the retry', async () => {
      const { project, job } = await assigned()
      await t.orchestrator.onConnected([], 'r1')
      await lost(job)
      ended(job, { kind: 'stopped', reason: 'Stopped' }, { wipSha: 'wip-sha' })
      await expect.poll(async () => (await run(job.runId)).headSha).toBe('wip-sha')
      await t.db.update(projects).set({ paused: true }).where(eq(projects.id, project.id))
    })

    it('counts a real failure against the task when no newer run has claimed it', async () => {
      const { project, task: created, job } = await assigned()
      await t.db.update(projects).set({ paused: true }).where(eq(projects.id, project.id))
      await t.orchestrator.onConnected([], 'r1')
      await lost(job)
      ended(job, { kind: 'exited', code: 1 })
      await expect.poll(async () => (await run(job.runId)).state).toBe('failed')
      expect(await task(created.id)).toMatchObject({ failedRuns: 1, status: 'in_progress' })
    })

    it('leaves the task alone when a newer run holds it', async () => {
      const { project, task: created, job } = await assigned()
      await t.orchestrator.onConnected([], 'r1')
      await lost(job)
      await t.orchestrator.schedule()
      const retry = (await runner.next('run.assign', m => m.job.taskId === created.id && m.job.runId !== job.runId)).job
      ended(job, { kind: 'exited', code: 1 })
      await expect.poll(async () => (await run(job.runId)).state).toBe('failed')
      expect(await task(created.id)).toMatchObject({ failedRuns: 0, leaseRunId: retry.runId })
      await t.db.update(projects).set({ paused: true }).where(eq(projects.id, project.id))
    })

    it('brings a PM reply to the session once, however often it is replayed', async () => {
      const project = await t.createProject()
      const session = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan it' }).then(r => r.json()) as PlanSessionDetail
      const { job } = await runner.next('run.assign', m => m.job.planSessionId === session.id)
      await t.orchestrator.onConnected([], 'r1')
      await lost(job)
      runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'pm-session' })
      runner.send({ type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [{ type: 'message', text: 'Here is the plan' }] })
      ended(job, { kind: 'exited', code: 0 })
      await expect.poll(async () => (await run(job.runId)).state).toBe('completed')
      expect(await run(job.runId)).toMatchObject({ summary: 'Here is the plan', error: null, agentSessionId: 'pm-session' })
      runner.send({ type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [{ type: 'message', text: 'Here is the plan' }] })
      ended(job, { kind: 'exited', code: 0 })
      await expect.poll(async () => (await run(job.runId)).transcriptBlob).not.toBeNull()
      await sleep(100)
      const said = await t.db.select().from(schema.planMessages).where(and(eq(schema.planMessages.runId, job.runId), eq(schema.planMessages.kind, 'message')))
      expect(said.map(m => m.text)).toEqual(['Here is the plan'])
      expect(await t.transcripts.spooled()).not.toContain(job.runId)
    })

    it('clears the failure of a PM turn taken as lost once its real reply is replayed', async () => {
      const project = await t.createProject()
      const session = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan it' }).then(r => r.json()) as PlanSessionDetail
      const { job } = await runner.next('run.assign', m => m.job.planSessionId === session.id)
      const status = async () => (await t.request('GET', `/api/plan/sessions/${session.id}`).then(r => r.json()) as PlanSessionDetail).status
      await t.orchestrator.onConnected([], 'r1')
      await lost(job)
      await expect.poll(status).toBe('failed')
      runner.send({ type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [{ type: 'message', text: 'Here is the plan' }] })
      ended(job, { kind: 'exited', code: 0 })
      await expect.poll(async () => (await run(job.runId)).state).toBe('completed')
      await expect.poll(status).toBe('none')
    })

    it('does not restart the clock of a run on a replayed run.started', async () => {
      const { project, job } = await assigned()
      const started = () => runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'session' })
      started()
      await expect.poll(async () => (await run(job.runId)).state).toBe('running')
      const { startedAt } = await run(job.runId)
      later(60_000)
      await t.db.update(runs).set({ state: 'stopping' }).where(eq(runs.id, job.runId))
      started()
      await sleep(100)
      expect(await run(job.runId)).toMatchObject({ state: 'stopping', startedAt })
      await t.db.update(projects).set({ paused: true }).where(eq(projects.id, project.id))
    })
  })

  describe('a server outage longer than the lease', () => {
    it('renews a run the reconnecting runner still has, so it carries on', async () => {
      const { project, task: created, job } = await assigned()
      later(LEASE_DURATION_MS + 60_000)
      const active = [{ runId: job.runId, leaseEpoch: job.leaseEpoch }]
      await t.orchestrator.onConnected(active, 'r1')
      await t.orchestrator.sweepLeases()
      expect((await run(job.runId)).state).toBe('queued')
      expect((await task(created.id)).leaseExpiresAt!.getTime()).toBeGreaterThan(t.clock.now.getTime())
      expect(runner.received.filter(m => m.type === 'run.stop' && m.runId === job.runId)).toEqual([])
      await t.orchestrator.onHeartbeat(active, 'r1')
      await sleep(50)
      expect(runner.received.filter(m => m.type === 'run.stop' && m.runId === job.runId)).toEqual([])
      await t.db.update(projects).set({ paused: true }).where(eq(projects.id, project.id))
    })

    it('renews nothing for a stale epoch', async () => {
      const { project, task: created, job } = await assigned()
      await t.db.update(projects).set({ paused: true }).where(eq(projects.id, project.id))
      await t.orchestrator.onConnected([{ runId: job.runId, leaseEpoch: job.leaseEpoch - 1 }], 'r1')
      expect((await run(job.runId)).state).toBe('interrupted')
      expect(await task(created.id)).toMatchObject({ leaseRunId: null, leaseExpiresAt: null })
      await runner.next('run.stop', m => m.runId === job.runId)
    })

    it('leaves leases alone until runners have had time to reconnect', async () => {
      const { project, job } = await assigned()
      later(LEASE_DURATION_MS + 60_000)
      t.orchestrator.start(3_600_000)
      t.orchestrator.stop()
      await t.orchestrator.sweepLeases()
      expect((await run(job.runId)).state).toBe('queued')
      later(3 * RUNNER_HEARTBEAT_MS)
      await t.orchestrator.sweepLeases()
      expect((await run(job.runId)).state).toBe('interrupted')
      await t.db.update(projects).set({ paused: true }).where(eq(projects.id, project.id))
    })
  })

  it('stores the transcript of a run that never got its run.ended, once a replay is no longer likely', async () => {
    const { project, job } = await assigned()
    await t.transcripts.append(job.runId, [{ type: 'system', text: 'Started' }])
    await t.orchestrator.onConnected([], 'r1')
    await t.orchestrator.sweepSpools()
    expect(await t.transcripts.spooled()).toContain(job.runId)
    later(61 * 60_000)
    await t.orchestrator.sweepSpools()
    expect(await t.transcripts.spooled()).not.toContain(job.runId)
    expect((await run(job.runId)).transcriptBlob).not.toBeNull()
    await t.db.update(projects).set({ paused: true }).where(eq(projects.id, project.id))
  })

  it('discards a spool whose run went with its project', async () => {
    const orphan = randomUUID()
    await t.transcripts.append(orphan, [{ type: 'system', text: 'Started' }])
    await t.orchestrator.sweepSpools()
    expect(await t.transcripts.spooled()).not.toContain(orphan)
  })

  it('fails a run whose assignment throws, freeing the agent, and carries on with the pass', async () => {
    const first = await approved()
    const second = await approved()
    const live = t.runner.send.bind(t.runner)
    let thrown = false
    vi.spyOn(t.runner, 'send').mockImplementation((message, id) => {
      if (message.type === 'run.assign' && !thrown) {
        thrown = true
        throw new Error('Prompt could not be built')
      }
      return live(message, id)
    })
    await t.orchestrator.schedule()
    const { job } = await runner.next('run.assign', m => m.job.taskId === first.task.id || m.job.taskId === second.task.id)
    const lost = job.taskId === first.task.id ? second.task : first.task
    expect((await t.db.select().from(tasks).where(eq(tasks.id, lost.id)))[0]).toMatchObject({ failedRuns: 1 })
    const [failed] = await t.db.select().from(runs).where(eq(runs.taskId, lost.id)).orderBy(runs.number)
    expect(failed).toMatchObject({ state: 'failed', error: 'Prompt could not be built' })
    for (const { project } of [first, second]) await t.db.update(projects).set({ paused: true }).where(eq(projects.id, project.id))
  })
})
