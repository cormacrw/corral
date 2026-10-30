import type { RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { agentActivity } from './agent-activity.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

const { agents, epics, runs } = schema

// The PM's view of the team, read through the runner protocol like a real turn
describe('get_agent_activity', () => {
  let t: TestApp
  let runner: FakeRunner
  let pm: RunJob
  let developer: typeof agents.$inferSelect
  let reviewer: typeof agents.$inferSelect

  // Ends the runs an earlier test left, so each one sees only its own
  const reset = () => t.db.delete(runs).where(eq(runs.agentId, developer.id))

  const activity = async (input: { agent?: string } = {}) => {
    const reply = await runner.call(pm.runId, pm.leaseEpoch, 'get_agent_activity', input)
    if (!reply.ok) throw new Error(reply.error)
    return reply.result as Awaited<ReturnType<typeof agentActivity>>
  }
  const named = async (name: string) => (await activity()).agents.find(a => a.name === name)!

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    await t.db.update(agents).set({ concurrency: 50 })
    runner = await FakeRunner.connect(t.server!.url)
    const all = await t.db.select().from(agents)
    developer = all.find(a => a.role === 'developer')!
    reviewer = all.find(a => a.role === 'reviewer')!
    const project = await t.createProject({ name: 'Planning project' })
    const res = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'What is the team working on?' })
    expect(res.status).toBe(201)
    pm = (await runner.next('run.assign', m => m.job.role === 'pm')).job
    runner.send({ type: 'run.started', runId: pm.runId, leaseEpoch: pm.leaseEpoch, agentSessionId: 'sess' })
    await vi.waitFor(async () => expect((await t.db.select().from(runs).where(eq(runs.id, pm.runId)))[0]?.state).toBe('running'))
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  it('returns every agent with its role, runtime and paused state', async () => {
    const until = new Date(Date.now() + 3_600_000)
    await t.db.update(agents).set({ pausedUntil: until }).where(eq(agents.id, reviewer.id))
    const { agents: team } = await activity()
    expect(team.map(a => a.name).sort()).toEqual((await t.db.select().from(agents)).map(a => a.name).sort())
    expect(team.find(a => a.name === developer.name)).toMatchObject({ role: 'developer', runtime: 'claude-code', status: 'idle', paused: false, pausedUntil: null, activeRuns: [], recentRuns: [] })
    expect(team.find(a => a.name === reviewer.name)).toMatchObject({ status: 'paused', pausedUntil: until.toISOString() })
    await t.db.update(agents).set({ pausedUntil: null }).where(eq(agents.id, reviewer.id))
  })

  it('shows an agent busy in another project, with that project\'s name', async () => {
    await reset()
    const other = await t.createProject({ name: 'Other project' })
    const task = await t.createTask(other.slug, { title: 'Billing page' })
    await t.db.insert(runs).values({ agentId: developer.id, projectId: other.id, taskId: task.id, role: 'developer', state: 'running', runnerName: 'gaming-pc', startedAt: new Date() })
    expect(await named(developer.name)).toMatchObject({
      status: 'busy',
      activeRunCount: 1,
      activeRuns: [{ state: 'running', project: 'Other project', task: { ref: task.ref, title: 'Billing page' }, epic: null, role: 'developer', runner: 'gaming-pc' }]
    })
  })

  it('shows an active epic review with its epic title', async () => {
    const project = await t.createProject()
    const [epic] = await t.db.insert(epics).values({ projectId: project.id, title: 'Saved searches', createdBy: t.actor }).returning()
    await t.db.insert(runs).values({ agentId: reviewer.id, projectId: project.id, epicId: epic!.id, role: 'reviewer', state: 'running', startedAt: new Date() })
    expect(await named(reviewer.name)).toMatchObject({ status: 'busy', activeRuns: [{ task: null, epic: { id: epic!.id, title: 'Saved searches' }, role: 'reviewer' }] })
    await t.db.delete(runs).where(eq(runs.epicId, epic!.id))
  })

  it('shows a failed or stuck run\'s state, error, runner and times', async () => {
    await reset()
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    const times = { queuedAt: new Date('2026-10-01T10:00:00Z'), startedAt: new Date('2026-10-01T10:01:00Z'), endedAt: new Date('2026-10-01T10:30:00Z') }
    await t.db.insert(runs).values([
      { agentId: developer.id, projectId: project.id, taskId: task.id, role: 'developer', state: 'failed', error: 'CLI exited with code 1', runnerName: 'gaming-pc', rateLimitResetAt: new Date('2026-10-01T12:00:00Z'), ...times },
      { agentId: developer.id, projectId: project.id, taskId: task.id, role: 'developer', state: 'completed', outcome: 'stuck', summary: 'Which API version?', runnerName: 'home-server', ...times }
    ])
    const agent = await named(developer.name)
    expect(agent).toMatchObject({ status: 'idle', activeRuns: [] })
    expect(agent.recentRuns).toMatchObject([
      { state: 'completed', outcome: 'stuck', summary: 'Which API version?', runner: 'home-server' },
      { state: 'failed', outcome: null, error: 'CLI exited with code 1', runner: 'gaming-pc', rateLimitResetAt: '2026-10-01T12:00:00.000Z', queuedAt: times.queuedAt.toISOString(), startedAt: times.startedAt.toISOString(), endedAt: times.endedAt.toISOString() }
    ])
  })

  it('caps the runs and shortens long text, with more for one named agent', async () => {
    await reset()
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    const base = { agentId: developer.id, projectId: project.id, taskId: task.id, role: 'developer' as const }
    await t.db.insert(runs).values([
      ...Array.from({ length: 12 }, () => ({ ...base, state: 'queued' as const })),
      { ...base, state: 'running', startedAt: new Date() },
      ...Array.from({ length: 25 }, () => ({ ...base, state: 'failed' as const, endedAt: new Date(), summary: 's'.repeat(5000), error: 'e'.repeat(5000) }))
    ])
    const team = await named(developer.name)
    expect(team.activeRunCount).toBe(13)
    expect(team.activeRuns).toHaveLength(10)
    // The run already working isn't hidden by the queue
    expect(team.activeRuns[0]).toMatchObject({ state: 'running' })
    expect(team.recentRuns).toHaveLength(3)
    expect(team.recentRuns[0]!.summary).toHaveLength(200)
    expect(team.recentRuns[0]!.error!.endsWith('…')).toBe(true)
    const { agents: [one] } = await activity({ agent: developer.name })
    expect(one!.recentRuns).toHaveLength(20)
    expect(one!.recentRuns[0]!.error).toHaveLength(500)
    expect(JSON.stringify(one).length).toBeLessThan(30_000)
  })

  it('finds a named agent in any case, and lists the valid names for an unknown one', async () => {
    expect((await activity({ agent: developer.name.toUpperCase() })).agents.map(a => a.name)).toEqual([developer.name])
    const reply = await runner.call(pm.runId, pm.leaseEpoch, 'get_agent_activity', { agent: 'Nobody' })
    expect(reply).toMatchObject({ ok: false, error: expect.stringContaining('There is no agent "Nobody". The agents are: ') })
    expect(reply).toMatchObject({ error: expect.stringContaining(developer.name) })
    expect(reply).toMatchObject({ error: expect.stringContaining(reviewer.name) })
  })

  it('is refused for every role but the PM', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug, { type: 'design', acceptanceCriteria: ['It works'] })
    await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
    await t.orchestrator.schedule()
    const job = (await runner.next('run.assign', m => m.job.taskId === task.id)).job
    expect(job.role).toBe('designer')
    // The server decides by the run's role, so the same run stands in for each
    for (const role of ['designer', 'developer', 'reviewer'] as const) {
      await t.db.update(runs).set({ role }).where(eq(runs.id, job.runId))
      expect(await runner.call(job.runId, job.leaseEpoch, 'get_agent_activity', {})).toMatchObject({ ok: false, error: `The ${role} can’t use get_agent_activity` })
    }
  })
})
