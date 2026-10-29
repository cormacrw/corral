import type { RunnerInfo } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { RunnerGitHub } from './github.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

// Real sockets and database: ownership must survive a second connection,
// reconnect, and setup jobs awaiting replies on another socket.
describe('multiple runners', () => {
  let t: TestApp
  const connections: FakeRunner[] = []
  async function connect(id: string, active: { runId: string, leaseEpoch: number }[] = []) {
    const runner = await FakeRunner.connect(t.server!.url, active, id)
    connections.push(runner)
    return runner
  }
  afterEach(async () => {
    for (const r of connections.splice(0)) r.close()
    await t?.close()
  })

  it('routes run controls and reconciliation by persisted owner', async () => {
    t = await createTestApp('pglite', { listen: true })
    const a = await connect('A')
    const project = await t.createProject({ repository: 'cormacrw/test-app' })
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const taskA = await t.createTask(project.slug)
    const taskB = await t.createTask(project.slug)
    const taskC = await t.createTask(project.slug)
    const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'developer'))
    // Seed claimed runs to exercise routing independently of dispatch policy.
    const jobs: { runId: string, leaseEpoch: number }[] = []
    for (const [task, runnerId] of [[taskA, 'A'], [taskB, 'B'], [taskC, 'B']] as const) {
      const [run] = await t.db.insert(schema.runs).values({ projectId: project.id, agentId: agent!.id, taskId: task.id, role: 'developer', runnerId, state: 'running', leaseEpoch: 1 }).returning()
      await t.db.update(schema.tasks).set({ status: 'in_progress', leaseRunId: run!.id, leaseRole: 'developer', leaseEpoch: 1, leaseExpiresAt: new Date(t.clock.now.getTime() + 900000) }).where(eq(schema.tasks.id, task.id))
      jobs.push({ runId: run!.id, leaseEpoch: 1 })
    }
    const b = await connect('B', [jobs[1]!, jobs[2]!])
    const status = await (await t.request('GET', '/api/status')).json() as { runners: RunnerInfo[] }
    expect(status.runners).toMatchObject([{ id: 'A', online: true }, { id: 'B', online: true }])
    expect(t.events.filter(e => e.type === 'runner.status').at(-1)).toMatchObject({ status: { runners: status.runners } })
    expect(await (await t.request('GET', `/api/runs/${jobs[1]!.runId}`)).json()).toMatchObject({ runnerId: 'B' })
    const message = await t.request('POST', `/api/projects/${project.slug}/runs/${jobs[1]!.runId}/messages`, { text: 'Please check this' })
    expect(message.status).toBe(202)
    expect(await b.next('run.message')).toMatchObject({ runId: jobs[1]!.runId, text: 'Please check this' })
    expect(a.received.some(m => m.type === 'run.message')).toBe(false)
    expect((await t.request('POST', `/api/runs/${jobs[2]!.runId}/stop`)).status).toBe(200)
    expect(await b.next('run.stop', m => m.runId === jobs[2]!.runId)).toMatchObject({ reason: 'Stopped by a human' })
    expect(a.received.some(m => m.type === 'run.stop')).toBe(false)
    // A heartbeat from B cannot renew A's lease, even with its epoch.
    const before = (await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskA.id)))[0]!.leaseExpiresAt
    t.clock.now = new Date(t.clock.now.getTime() + 60000)
    b.send({ type: 'heartbeat', activeRuns: [jobs[0]!, jobs[1]!] })
    expect(await b.next('run.stop', m => m.runId === jobs[0]!.runId)).toMatchObject({ reason: 'This run no longer holds its lease' })
    expect((await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskA.id)))[0]!.leaseExpiresAt).toEqual(before)
    await connect('B')
    await vi.waitFor(async () => expect((await t.db.select().from(schema.runs).where(eq(schema.runs.id, jobs[1]!.runId)))[0]!.state).toBe('interrupted'))
    expect((await t.db.select().from(schema.runs).where(eq(schema.runs.id, jobs[0]!.runId)))[0]!.state).toBe('running')
    expect((await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskA.id)))[0]!.leaseRunId).toBe(jobs[0]!.runId)
    a.send({ type: 'heartbeat', activeRuns: [jobs[0]!] })
    await vi.waitFor(async () => expect((await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, taskA.id)))[0]!.leaseExpiresAt!.getTime()).toBeGreaterThan(before!.getTime()))
    expect((await t.request('POST', `/api/runs/${jobs[0]!.runId}/stop`)).status).toBe(200)
    expect(await a.next('run.stop')).toMatchObject({ runId: jobs[0]!.runId })
    const [legacy] = await t.db.insert(schema.runs).values({ projectId: project.id, agentId: agent!.id, taskId: taskA.id, role: 'developer', state: 'completed' }).returning()
    expect(await (await t.request('GET', `/api/runs/${legacy!.id}`)).json()).toMatchObject({ runnerId: null, state: 'completed' })
  }, 30000)

  it('prefers the oldest connection, broadcasts cleanup, and isolates pending jobs', async () => {
    t = await createTestApp('pglite', { listen: true })
    const a = await connect('A')
    const b = await connect('B')
    a.onJob = () => null
    b.onJob = () => null
    const pendingA = t.runner.request({ kind: 'detect_clis' }).catch(e => e.message)
    const requestA = await a.next('job.request')
    const cleanup = t.runner.request({ kind: 'cleanup_worktrees', repository: 'cormacrw/test-app', taskId: 'task' }).catch(e => e.message)
    await a.next('job.request', m => m.job.kind === 'cleanup_worktrees')
    const cleanupB = await b.next('job.request', m => m.job.kind === 'cleanup_worktrees')
    a.close()
    expect(await pendingA).toBe('Runner disconnected')
    expect(await cleanup).toBe('Runner disconnected')
    // B's pending job still accepts its response after A disconnects.
    b.send({ type: 'job.result', jobId: cleanupB.jobId, ok: true, result: { kind: 'cleanup_worktrees', removed: [], kept: [] } })
    const pendingB = t.runner.request({ kind: 'detect_clis' })
    const requestB = await b.next('job.request', m => m.job.kind === 'detect_clis')
    const reconnectedA = await connect('A')
    reconnectedA.close()
    await vi.waitFor(() => expect(t.runner.isOnline('A')).toBe(false))
    b.send({ type: 'job.result', jobId: requestB.jobId, ok: true, result: { kind: 'detect_clis', clis: [] } })
    expect(await pendingB).toEqual({ kind: 'detect_clis', clis: [] })
    b.onJob = (job) => {
      if (job.kind === 'session_title') return { kind: 'session_title', title: 'A useful title' }
      if (job.kind === 'github') return { kind: 'github', status: 200, body: { check_runs: [], statuses: [] } }
      if (job.kind === 'detect_clis') return { kind: 'detect_clis', clis: [] }
      if (job.kind === 'list_repos') return { kind: 'list_repos', signedIn: true, repos: [] }
      return null
    }
    expect((await t.request('GET', '/api/setup/clis')).status).toBe(200)
    expect((await t.request('GET', '/api/setup/repos')).status).toBe(200)
    expect(await t.runner.request({ kind: 'session_title', prompt: 'Name this session' })).toMatchObject({ title: 'A useful title' })
    expect(await new RunnerGitHub(t.runner).checks('cormacrw/test-app', 'head')).toEqual([])
    expect(requestA.job.kind).toBe('detect_clis')
    b.close()
    await vi.waitFor(() => expect(t.runner.online).toBe(false))
    expect((await t.request('GET', '/api/setup/clis')).status).toBe(503)
    const project = await t.createProject({ repository: 'cormacrw/test-app' })
    expect(await (await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan offline' })).json()).toEqual({ error: { code: 'runner_offline' } })
    // A turn already accepted by the service waits across a connection gap.
    const [session] = await t.db.insert(schema.planSessions).values({ projectId: project.id, title: 'Queued turn', createdBy: t.actor }).returning()
    const runId = await t.orchestrator.startPmRun(session!, {
      role: 'pm', projectId: project.id, repository: project.repository, defaultBranch: project.defaultBranch,
      taskId: null, taskRef: null, branch: null, headSha: null, planSessionId: session!.id,
      agentSessionId: null, runtime: 'claude-code', model: null, timeoutSeconds: 600, prompt: 'Wait for an online runner', fallbackPrompt: null
    })
    const [waiting] = await t.db.select().from(schema.runs).where(eq(schema.runs.id, runId))
    expect(waiting).toMatchObject({ state: 'queued', runnerId: null })
    expect(waiting!.pmJob).not.toBeNull()
    const back = await connect('B')
    await back.next('run.assign', m => m.job.runId === waiting!.id)
    expect((await t.db.select().from(schema.runs).where(eq(schema.runs.id, waiting!.id)))[0]).toMatchObject({ runnerId: 'B', pmJob: null })
  }, 30000)
})
