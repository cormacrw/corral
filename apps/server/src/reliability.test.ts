import { schema } from '@corral/db'
import { eq, ne } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

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
