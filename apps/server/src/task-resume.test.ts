import type { Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { and, desc, eq, ne } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest'
import { createApp } from './app.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

const { agents, auditLog, runs, tasks } = schema

// Stopping a run pauses its task (flows.md §3); only a human's resume lets
// the scheduler take it again
describe('resuming a paused task', () => {
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

  beforeEach(async () => {
    await t.db.update(agents).set({ wakeIntervalSeconds: null })
  })

  // A task whose developer run a human just stopped
  async function stopped() {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
    const { job } = await runner.next('run.assign', m => m.job.taskId === task.id)
    expect((await t.request('POST', `/api/runs/${job.runId}/stop`)).status).toBe(200)
    return { project, task }
  }

  const resume = (slug: string, number: number) => t.request('POST', `/api/projects/${slug}/tasks/${number}/resume`)
  const row = async (id: string) => (await t.db.select().from(tasks).where(eq(tasks.id, id)))[0]!
  const runsOf = (id: string) => t.db.select().from(runs).where(eq(runs.taskId, id)).orderBy(desc(runs.number))

  it('shows a stopped task as paused, and no pass restarts it', async () => {
    const { project, task } = await stopped()
    expect(t.events.findLast((e): e is { type: 'task.updated', task: Task } => e.type === 'task.updated' && e.task.id === task.id)?.task.paused).toBe(true)
    await t.orchestrator.tick()
    expect(await runsOf(task.id)).toHaveLength(1)
    const res = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}`)
    expect(await res.json()).toMatchObject({ status: 'in_progress', paused: true })
  })

  it('starts a developer run on a paused In progress task and clears the pause', async () => {
    const { project, task } = await stopped()
    const res = await resume(project.slug, task.number)
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ status: 'in_progress', paused: false })
    const { job } = await runner.next('run.assign', m => m.job.taskId === task.id)
    expect(job.role).toBe('developer')
    expect(await row(task.id)).toMatchObject({ paused: false, leaseRunId: job.runId })
    const [audit] = await t.db.select().from(auditLog).where(and(eq(auditLog.taskId, task.id), eq(auditLog.action, 'task.resumed')))
    expect(audit).toMatchObject({ actor: t.actor })
  })

  it('starts a reviewer run on a paused Agent review task', async () => {
    const { project, task } = await stopped()
    await t.db.update(tasks).set({ status: 'agent_review', headSha: 'abc123' }).where(eq(tasks.id, task.id))
    expect((await resume(project.slug, task.number)).status).toBe(200)
    const { job } = await runner.next('run.assign', m => m.job.taskId === task.id)
    expect(job.role).toBe('reviewer')
    expect(await row(task.id)).toMatchObject({ status: 'agent_review', paused: false, leaseRunId: job.runId })
  })

  it('starts the task straight away inside the agent’s wake interval', async () => {
    const { project, task } = await stopped()
    await t.db.update(agents).set({ wakeIntervalSeconds: 3600 })
    // The stopped run has only just started, so nothing else would claim yet
    await t.orchestrator.schedule()
    expect(await runsOf(task.id)).toHaveLength(1)
    expect((await resume(project.slug, task.number)).status).toBe(200)
    const { job } = await runner.next('run.assign', m => m.job.taskId === task.id)
    expect(job.role).toBe('developer')
    expect(await runsOf(task.id)).toHaveLength(2)
  })

  it('refuses a task that isn’t paused', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    const res = await resume(project.slug, task.number)
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: { code: 'conflict', constraint: 'task_not_paused' } })
  })

  it('refuses anyone but a human', async () => {
    const { project, task } = await stopped()
    const [run] = await runsOf(task.id)
    const agentApi = createApp({ ...t, events: t.bus, actor: { kind: 'agent', role: 'developer', runId: run!.id } })
    const res = await agentApi.request(`/api/projects/${project.slug}/tasks/${task.number}/resume`, { method: 'POST' })
    expect(res.status).toBe(403)
    expect(await res.json()).toEqual({ error: { code: 'forbidden' } })
    expect(await row(task.id)).toMatchObject({ paused: true })
  })

  it('can’t be resumed through a task edit', async () => {
    const { project, task } = await stopped()
    await t.request('PATCH', `/api/projects/${project.slug}/tasks/${task.number}`, { paused: false })
    expect(await row(task.id)).toMatchObject({ paused: true })
  })
})
