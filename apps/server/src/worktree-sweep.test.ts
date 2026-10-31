import type { Project, ServerMessage } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'
import { PM_WORKTREE_TTL } from './worktree-sweep.ts'

const { auditLog, comments, planSessions, runs, tasks } = schema

type SweepJob = Extract<Extract<ServerMessage, { type: 'job.request' }>['job'], { kind: 'sweep_worktrees' }>

describe('worktree sweep', () => {
  let t: TestApp
  let project: Project
  const connections: FakeRunner[] = []

  async function connect(id = 'r1') {
    const runner = await FakeRunner.connect(t.server!.url, [], id)
    connections.push(runner)
    return runner
  }

  async function sweepJob(runner: FakeRunner): Promise<SweepJob> {
    return (await runner.next('job.request', m => m.job.kind === 'sweep_worktrees')).job as SweepJob
  }

  async function swept() {
    return (await t.db.select().from(auditLog)).filter(row => row.action === 'worktrees.swept')
  }

  async function session(updatedAt: Date) {
    const [row] = await t.db.insert(planSessions).values({ projectId: project.id, title: 'Plan', createdBy: t.actor, updatedAt }).returning()
    return row!
  }

  beforeEach(async () => {
    t = await createTestApp('pglite', { listen: true })
    project = await t.createProject({ repository: 'cormacrw/test-app' })
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  })

  afterEach(async () => {
    t.orchestrator.sweep.stop()
    for (const r of connections.splice(0)) r.close()
    await t.close()
  })

  it('sweeps when a runner connects and records what was removed', async () => {
    const r = await connect()
    await sweepJob(r)
    await expect.poll(swept).toHaveLength(1)
    const path = '/data/worktrees/gone'
    r.onJob = () => ({ kind: 'sweep_worktrees', removed: [path], kept: ['/data/worktrees/dirty'] })
    await t.orchestrator.sweep.run()
    await expect.poll(swept).toHaveLength(2)
    expect((await swept())[1]).toMatchObject({
      projectId: null,
      taskId: null,
      actor: { kind: 'system', component: 'server' },
      detail: { removed: [path], kept: ['/data/worktrees/dirty'] }
    })
  })

  it('keeps every unmerged task and drops merged and deleted ones', async () => {
    const statuses = ['backlog', 'ready', 'in_progress', 'agent_review', 'human_review', 'ready_to_merge', 'blocked', 'failed'] as const
    const open = []
    for (const status of statuses) {
      const task = await t.createTask(project.slug)
      await t.db.update(tasks).set({ status, statusReason: status === 'blocked' || status === 'failed' ? 'Waiting for a decision' : null }).where(eq(tasks.id, task.id))
      open.push(task.id)
    }
    const merged = await t.createTask(project.slug)
    await t.db.update(tasks).set({ status: 'merged' }).where(eq(tasks.id, merged.id))
    const softDeleted = await t.createTask(project.slug)
    await t.db.update(tasks).set({ status: 'in_progress', deletedAt: new Date() }).where(eq(tasks.id, softDeleted.id))

    const job = await sweepJob(await connect())
    expect([...job.keepTaskIds].sort()).toEqual([...open].sort())
  })

  it('keeps Plan sessions that are recent or have a turn active, and no others', async () => {
    const now = t.clock.now.getTime()
    const stale = await session(new Date(now - PM_WORKTREE_TTL - 1000))
    const recent = await session(new Date(now - PM_WORKTREE_TTL + 60_000))
    const ended = await session(new Date(now - PM_WORKTREE_TTL - 1000))
    const kept = []
    for (const state of ['queued', 'running'] as const) {
      const row = await session(new Date(now - PM_WORKTREE_TTL * 3))
      await pmRun(row.id, state)
      kept.push(row.id)
    }
    await pmRun(ended.id, 'completed')

    const job = await sweepJob(await connect())
    expect([...job.keepPlanSessionIds].sort()).toEqual([recent.id, ...kept].sort())
    expect(job.keepPlanSessionIds).not.toContain(stale.id)
  })

  it('does nothing and logs no error with no runner online', async () => {
    const errors = vi.spyOn(console, 'error')
    t.orchestrator.sweep.start(5)
    await sleep(40)
    t.orchestrator.sweep.stop()
    expect(await swept()).toEqual([])
    expect(errors).not.toHaveBeenCalled()
    errors.mockRestore()
  })

  it('sweeps on the hourly tick', async () => {
    const runner = await connect()
    await sweepJob(runner)
    await expect.poll(swept).toHaveLength(1)
    t.orchestrator.sweep.start(5)
    await sweepJob(runner)
    t.orchestrator.sweep.stop()
  })

  it('posts no task comments, even for kept worktrees', async () => {
    const task = await t.createTask(project.slug)
    await t.db.update(tasks).set({ status: 'merged' }).where(eq(tasks.id, task.id))
    const runner = await connect()
    await sweepJob(runner)
    runner.onJob = () => ({ kind: 'sweep_worktrees', removed: [], kept: [`/data/worktrees/${task.id}`] })
    await t.orchestrator.sweep.run()
    expect(await swept()).toHaveLength(2)
    expect(await t.db.select().from(comments)).toEqual([])
  })

  it('broadcasts to every online runner, and one failing keeps the others\' results', async () => {
    const a = await connect('A')
    await sweepJob(a)
    const b = await connect('B')
    await sweepJob(b)
    await expect.poll(swept).toHaveLength(2)
    const errors = vi.spyOn(console, 'error').mockImplementation(() => {})
    a.onJob = () => {
      throw new Error('git worktree list failed')
    }
    b.onJob = () => ({ kind: 'sweep_worktrees', removed: ['/b/gone'], kept: [] })
    await t.orchestrator.sweep.run()
    expect((await swept()).at(-1)!.detail).toEqual({ removed: ['/b/gone'], kept: [] })
    expect(errors).toHaveBeenCalledWith('Worktree sweep failed on a runner', expect.any(Error))
    errors.mockRestore()
  })

  it('runs again after a sweep when asked during it', async () => {
    const runner = await connect()
    await sweepJob(runner)
    await expect.poll(swept).toHaveLength(1)
    await Promise.all([t.orchestrator.sweep.run(), t.orchestrator.sweep.run(), t.orchestrator.sweep.run()])
    expect(await swept()).toHaveLength(3)
  })

  async function pmRun(planSessionId: string, state: 'queued' | 'running' | 'completed') {
    const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'pm'))
    await t.db.insert(runs).values({ projectId: project.id, planSessionId, agentId: agent!.id, role: 'pm', state, endedAt: state === 'completed' ? new Date() : null })
  }
})
