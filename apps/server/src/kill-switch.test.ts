import { databaseFixture } from '@corral/db/testing'
import type { Project, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { and, eq, ne } from 'drizzle-orm'
import { afterAll, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'

const { agents, auditLog, epics, runs, tasks } = schema

// Stops racing an assignment that's still being prepared (PRD §7.11). An
// assignment sent after its stop can never be stopped: the runner ignores a
// run.stop for a run it doesn't know yet.
describe('stopping work that is being claimed', () => {
  let t: TestApp
  let runner: FakeRunner

  databaseFixture('postgres', async () => {
    t = await createTestApp('postgres', { listen: true })
    await t.db.update(agents).set({ concurrency: 50 }).where(ne(agents.role, 'pm'))
    runner = await FakeRunner.connect(t.server!.url, [], 'r1', { slots: 50 })
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  const assignments = (taskId: string) => runner.received.filter(m => m.type === 'run.assign' && m.job.taskId === taskId)

  async function pause(project: Project) {
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  }

  async function approvedInEpic(): Promise<{ project: Project, task: Task }> {
    const project = await t.createProject()
    const [epic] = await t.db.insert(epics).values({ projectId: project.id, createdBy: t.actor, title: 'Search', reviewMode: 'epic', branch: `corral/epic-${project.id}` }).returning()
    t.github.setBranch(project.repository, epic!.branch!, 'epic-head')
    const task = await t.createTask(project.slug, { epicId: epic!.id })
    return { project, task }
  }

  const approve = (project: Project, task: Task) => t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })

  // Runs `during` while the job is being prepared: its claim has committed,
  // and preparing it reads the epic branch from GitHub
  async function whilePreparing(during: (runId: string) => Promise<void>, task: Task) {
    const live = t.github.branchHead.bind(t.github)
    const spy = vi.spyOn(t.github, 'branchHead').mockImplementationOnce(async (...args) => {
      const [run] = await t.db.select().from(runs).where(eq(runs.taskId, task.id))
      await during(run!.id)
      return live(...args)
    })
    return () => spy.mockRestore()
  }

  it('sends nothing for a run the kill switch ended while its job was being prepared', async () => {
    const { project, task } = await approvedInEpic()
    let stopped: Promise<Response> | undefined
    const restore = await whilePreparing(async (runId) => {
      stopped = t.request('POST', '/api/stop-all')
      await vi.waitFor(async () => expect((await t.db.select().from(runs).where(eq(runs.id, runId)))[0]).toMatchObject({ state: 'interrupted' }), { timeout: 20_000 })
    }, task)
    await approve(project, task)
    await t.orchestrator.schedule()
    expect((await stopped!).status).toBe(200)
    restore()
    await sleep(50)
    expect(assignments(task.id)).toEqual([])
    await pause(project)
    await t.request('POST', '/api/resume-all')
  })

  it('stops a run claimed after the kill switch read the live runs', async () => {
    const { project, task } = await approvedInEpic()
    let stopped: Promise<void> | undefined
    // The claim is still open when the switch is thrown, so its run isn't
    // in stopAll's first read
    const live = t.runner.available.bind(t.runner)
    const spy = vi.spyOn(t.runner, 'available').mockImplementationOnce(() => {
      stopped = t.orchestrator.stopAll(t.actor)
      return live()
    })
    await approve(project, task)
    await t.orchestrator.schedule()
    await stopped
    spy.mockRestore()
    await sleep(50)
    expect(assignments(task.id)).toEqual([])
    const taskRuns = await t.db.select().from(runs).where(eq(runs.taskId, task.id))
    expect(taskRuns.map(r => r.state).filter(s => s !== 'interrupted')).toEqual([])
    expect((await t.db.select().from(tasks).where(eq(tasks.id, task.id)))[0]).toMatchObject({ leaseRunId: null })
    await pause(project)
    await t.request('POST', '/api/resume-all')
  })

  it('sends nothing for a queued run a human stopped while its job was being prepared', async () => {
    const { project, task } = await approvedInEpic()
    const restore = await whilePreparing(runId => t.orchestrator.stopRun(runId, t.actor), task)
    await approve(project, task)
    await t.orchestrator.schedule()
    restore()
    await sleep(50)
    expect(assignments(task.id)).toEqual([])
    await pause(project)
  })

  it('revokes a run that never started, rather than letting it finish saving', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    await approve(project, task)
    await t.orchestrator.schedule()
    const { job } = await runner.next('run.assign', m => m.job.taskId === task.id)
    await t.orchestrator.stopAll(t.actor)
    expect((await runner.next('run.stop', m => m.runId === job.runId)).keepWork).toBe(true)
    await t.orchestrator.onHeartbeat([{ runId: job.runId, leaseEpoch: job.leaseEpoch }], 'r1')
    expect((await runner.next('run.stop', m => m.runId === job.runId)).keepWork).toBeUndefined()
    await pause(project)
    await t.request('POST', '/api/resume-all')
  })

  it('keeps an accepted outcome when a stop read the run before it landed, and audits one end', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    await approve(project, task)
    await t.orchestrator.schedule()
    const { job } = await runner.next('run.assign', m => m.job.taskId === task.id)
    await t.db.update(tasks).set({ leaseExpiresAt: new Date(t.clock.now.getTime() - 1000) }).where(eq(tasks.id, task.id))
    // The sweep has read the run as live; the outcome commits just before its write
    const transaction = t.db.transaction.bind(t.db)
    const spy = vi.spyOn(t.db, 'transaction').mockImplementationOnce(async (...args) => {
      await t.db.update(runs).set({ state: 'completed', endedAt: new Date(), outcome: 'pr_opened', summary: 'Done' }).where(eq(runs.id, job.runId))
      return transaction(...args)
    })
    await t.orchestrator.sweepLeases()
    spy.mockRestore()
    expect((await t.db.select().from(runs).where(eq(runs.id, job.runId)))[0]).toMatchObject({ state: 'completed', outcome: 'pr_opened', error: null })
    expect(await t.db.select().from(auditLog).where(and(eq(auditLog.taskId, task.id), eq(auditLog.action, 'run.ended')))).toEqual([])
    await pause(project)
  })
})
