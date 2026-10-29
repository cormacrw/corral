import type { Project } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

const { agents, projects, runs } = schema

// A per-agent wake interval: the periodic tick starts work for the agent at
// most this often, while events such as approval still start it right away
describe('agent wake interval', () => {
  let t: TestApp
  let runner: FakeRunner
  let developerId: string

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    await t.db.update(agents).set({ concurrency: 50 })
    const [developer] = await t.db.select().from(agents).where(eq(agents.role, 'developer'))
    developerId = developer!.id
    runner = await FakeRunner.connect(t.server!.url)
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  function minutes(n: number) {
    t.clock.now = new Date(t.clock.now.getTime() + n * 60_000)
  }

  const setPaused = (project: Project, paused: boolean) =>
    t.db.update(projects).set({ paused }).where(eq(projects.id, project.id))

  // Approved tasks that only the next tick can pick up: approval pokes the
  // scheduler, so the project is paused until the tick runs
  async function waitingTasks(count: number): Promise<Project> {
    const project = await t.createProject()
    await setPaused(project, true)
    for (let i = 0; i < count; i++) {
      const task = await t.createTask(project.slug)
      expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })).status).toBe(200)
    }
    await t.orchestrator.schedule()
    return project
  }

  const runsIn = async (project: Project) => (await t.db.select().from(runs).where(eq(runs.projectId, project.id))).length

  async function setInterval(seconds: number | null) {
    const res = await t.request('PATCH', `/api/agents/${developerId}`, { wakeIntervalSeconds: seconds })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ wakeIntervalSeconds: seconds })
  }

  it('defaults to null, and a tick then starts every waiting task as before', async () => {
    const list = await t.request('GET', '/api/agents').then(r => r.json()) as { wakeIntervalSeconds: number | null }[]
    expect(list.every(a => a.wakeIntervalSeconds === null)).toBe(true)
    const project = await waitingTasks(3)
    expect(await runsIn(project)).toBe(0)
    await setPaused(project, false)
    await t.orchestrator.tick()
    expect(await runsIn(project)).toBe(3)
    await setPaused(project, true)
  })

  it('starts the agent at most once per interval from the tick', async () => {
    await setInterval(600)
    try {
      minutes(11)
      const project = await waitingTasks(3)
      await setPaused(project, false)
      await t.orchestrator.tick()
      expect(await runsIn(project)).toBe(1)
      for (const step of [1, 4, 4]) {
        minutes(step)
        await t.orchestrator.tick()
        expect(await runsIn(project)).toBe(1)
      }
      minutes(1)
      await t.orchestrator.tick()
      expect(await runsIn(project)).toBe(2)
      await setPaused(project, true)
    } finally {
      await setInterval(null)
    }
  })

  it('leaves waiting work for the interval when a run ends or settings change', async () => {
    await setInterval(600)
    try {
      minutes(11)
      const project = await waitingTasks(3)
      await setPaused(project, false)
      await t.orchestrator.tick()
      expect(await runsIn(project)).toBe(1)
      const { job } = await runner.next('run.assign', m => m.job.projectId === project.id)

      // The run's exit pokes the scheduler; waiting work still waits
      minutes(2)
      runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 1 }, headSha: null })
      await vi.waitFor(async () => {
        const [run] = await t.db.select().from(runs).where(eq(runs.id, job.runId))
        expect(run!.endedAt).not.toBeNull()
      })
      await t.orchestrator.schedule()
      expect(await runsIn(project)).toBe(1)

      // So does saving the agent's settings
      minutes(2)
      await setInterval(600)
      await t.orchestrator.schedule()
      await t.orchestrator.tick()
      expect(await runsIn(project)).toBe(1)

      minutes(6)
      await t.orchestrator.tick()
      expect(await runsIn(project)).toBe(2)
      await setPaused(project, true)
    } finally {
      await setInterval(null)
    }
  })

  it('still starts work right away on an event such as approval', async () => {
    await setInterval(600)
    try {
      minutes(11)
      const ticked = await waitingTasks(2)
      await setPaused(ticked, false)
      await t.orchestrator.tick()
      expect(await runsIn(ticked)).toBe(1)

      minutes(1)
      const project = await t.createProject()
      const task = await t.createTask(project.slug)
      expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })).status).toBe(200)
      await t.orchestrator.schedule()
      const { job } = await runner.next('run.assign', m => m.job.taskId === task.id)
      expect(job.role).toBe('developer')
      // Only the approved task skips the interval, not the agent's other waiting work
      expect(await runsIn(ticked)).toBe(1)
      await setPaused(project, true)
      await setPaused(ticked, true)
    } finally {
      await setInterval(null)
    }
  })

  it('rejects an interval for the PM, which never starts on the tick', async () => {
    const [pm] = await t.db.select().from(agents).where(eq(agents.role, 'pm'))
    const res = await t.request('PATCH', `/api/agents/${pm!.id}`, { wakeIntervalSeconds: 600 })
    expect(res.status).toBe(400)
  })
})
