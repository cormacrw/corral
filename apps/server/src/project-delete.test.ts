import type { Project, ServerEvent } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq, ne } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'

const { agents, auditLog, epics, planSessions, runs, tasks } = schema

// design/project-settings.md, Danger zone: removing a project, on Postgres
// with a fake runner and FakeGitHub
describe('removing a project', () => {
  let t: TestApp
  let runner: FakeRunner

  beforeAll(async () => {
    t = await createTestApp('postgres', { listen: true })
    await t.db.update(agents).set({ concurrency: 50 }).where(ne(agents.role, 'pm'))
    runner = await FakeRunner.connect(t.server!.url)
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  const remove = (project: Project, body?: unknown) => t.request('DELETE', `/api/projects/${project.slug}`, body)
  const listed = async () => (await t.request('GET', '/api/projects').then(r => r.json()) as Project[]).map(p => p.id)
  const tasksOf = (project: Project) => t.db.select().from(tasks).where(eq(tasks.projectId, project.id))

  it('refuses a wrong or missing confirmation and deletes nothing', async () => {
    const project = await t.createProject({ name: 'Keep me' })
    await t.createTask(project.slug)
    for (const body of [undefined, {}, { confirm: 'keep me' }, { confirm: 'Keep me ' }, { confirm: 'Something else' }]) {
      const res = await remove(project, body)
      expect(res.status).toBe(400)
      expect(await res.json()).toMatchObject({ error: { code: 'invalid_input' } })
    }
    expect(await listed()).toContain(project.id)
    expect(await tasksOf(project)).toHaveLength(1)
    expect(t.events.some(e => e.type === 'project.deleted' && e.projectId === project.id)).toBe(false)
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  })

  it('returns 404 for an unknown project', async () => {
    expect((await t.request('DELETE', '/api/projects/no-such-project', { confirm: 'x' })).status).toBe(404)
  })

  it('stops running work, removes the project and its tasks, leaves GitHub and other projects alone', async () => {
    const other = await t.createProject()
    const otherTask = await t.createTask(other.slug)
    const project = await t.createProject({ name: 'Doomed' })
    const backlog = await t.createTask(project.slug)
    const running = await t.createTask(project.slug)
    await t.request('POST', `/api/projects/${project.slug}/tasks/${running.number}/transitions`, { type: 'approve' })
    await t.orchestrator.schedule()
    const run = (await runner.next('run.assign', m => m.job.taskId === running.id)).job
    const [leased] = await t.db.select().from(tasks).where(eq(tasks.id, running.id))
    expect(leased).toMatchObject({ leaseRunId: run.runId, status: 'in_progress' })

    // When the stopped run is published, the task still exists: record its lease then
    const leaseAtStop: Promise<string | null | undefined>[] = []
    const unsubscribe = t.bus.subscribe((event: ServerEvent) => {
      if (event.type === 'run.updated' && event.run.id === run.runId && event.run.state === 'interrupted') {
        leaseAtStop.push(t.db.select().from(tasks).where(eq(tasks.id, running.id)).then(([row]) => row?.leaseRunId))
      }
    })
    const githubCalls = t.github.calls.length
    const before = t.events.length

    const res = await remove(project, { confirm: 'Doomed' })
    unsubscribe()
    expect(res.status).toBe(204)

    // The run was stopped and its lease released before the delete
    await runner.next('run.stop', m => m.runId === run.runId)
    expect(leaseAtStop).toHaveLength(1)
    expect(await leaseAtStop[0]).toBeNull()
    const order = t.events.slice(before).map(e => e.type)
    expect(order.indexOf('run.updated')).toBeGreaterThanOrEqual(0)
    expect(order.indexOf('run.updated')).toBeLessThan(order.indexOf('project.deleted'))

    // The project and everything under it are gone
    expect(await listed()).not.toContain(project.id)
    expect((await t.request('GET', `/api/projects/${project.slug}`)).status).toBe(404)
    expect(await tasksOf(project)).toHaveLength(0)
    expect(await t.db.select().from(runs).where(eq(runs.projectId, project.id))).toHaveLength(0)
    expect(await t.db.select().from(epics).where(eq(epics.projectId, project.id))).toHaveLength(0)
    expect(await t.db.select().from(planSessions).where(eq(planSessions.projectId, project.id))).toHaveLength(0)
    expect((await t.request('GET', `/api/projects/${project.slug}/tasks/${backlog.number}`)).status).toBe(404)
    const [audit] = await t.db.select().from(auditLog).where(eq(auditLog.action, 'project.deleted'))
    expect(audit).toMatchObject({ projectId: null, detail: { projectId: project.id, name: 'Doomed' } })

    // Clients are told
    expect(t.events.slice(before)).toContainEqual({ type: 'project.deleted', projectId: project.id })

    // No GitHub call at all
    expect(t.github.calls.slice(githubCalls)).toEqual([])

    // The runner is asked to clean up the worked task's worktrees, not the backlog one's
    const cleanup = await runner.next('job.request', m => m.job.kind === 'cleanup_worktrees' && m.job.taskId === running.id)
    expect(cleanup.job).toMatchObject({ repository: project.repository })
    await sleep(50)
    expect(runner.received.some(m => m.type === 'job.request' && m.job.kind === 'cleanup_worktrees' && m.job.taskId === backlog.id)).toBe(false)

    // The other project is untouched
    expect(await listed()).toContain(other.id)
    expect(await tasksOf(other)).toEqual([expect.objectContaining({ id: otherTask.id, status: 'backlog' })])
    expect((await t.request('GET', `/api/projects/${other.slug}/tasks/${otherTask.number}`)).status).toBe(200)
  })
})
