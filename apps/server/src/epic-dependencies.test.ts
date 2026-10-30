import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { claimNextTask } from './claim.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

const { agents, epics, epicDependencies, tasks } = schema

describe('epic scheduling', () => {
  let t: TestApp
  let runner: FakeRunner | undefined
  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
  })
  afterEach(async () => {
    runner?.close()
    runner = undefined
    await t.orchestrator.schedule()
    await t.db.delete(schema.projects)
  })
  afterAll(async () => {
    await t?.close()
  })

  async function setup() {
    const project = await t.createProject({ repository: 'cormacrw/test-app', defaultBranch: 'main' })
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    const [a, b] = await t.db.insert(epics).values(['Foundation', 'Application'].map(title => ({ projectId: project.id, title, createdBy: t.actor }))).returning()
    await t.db.insert(epicDependencies).values({ epicId: b!.id, dependsOnEpicId: a!.id })
    const first = await t.createTask(project.slug)
    const second = await t.createTask(project.slug)
    await t.db.update(tasks).set({ epicId: a!.id, status: 'blocked' }).where(eq(tasks.id, first.id))
    await t.db.update(tasks).set({ epicId: b!.id, status: 'ready' }).where(eq(tasks.id, second.id))
    const [dev] = await t.db.select().from(agents).where(eq(agents.role, 'developer'))
    await t.db.update(schema.projects).set({ paused: false }).where(eq(schema.projects.id, project.id))
    return { project, a: a!, b: b!, first, second, dev: dev! }
  }

  it('reports unfinished prerequisite epics on API tasks and clears them in live completion updates', async () => {
    const { project, a, first, second } = await setup()
    const get = async (number: number) => (await t.request('GET', `/api/projects/${project.slug}/tasks/${number}`)).json()
    expect(await get(second.number)).toMatchObject({ dependsOn: [], waitingOnEpics: [{ id: a.id, title: a.title }] })
    expect(await get(first.number)).toMatchObject({ waitingOnEpics: [] })
    for (const status of ['draft', 'backlog', 'merged'] as const) {
      await t.db.update(tasks).set({ status }).where(eq(tasks.id, first.id))
      expect(await get(second.number)).toMatchObject({ waitingOnEpics: [] })
    }
    await t.db.update(tasks).set({ status: 'blocked', deletedAt: new Date() }).where(eq(tasks.id, first.id))
    expect(await get(second.number)).toMatchObject({ waitingOnEpics: [] })
    await t.db.update(tasks).set({ status: 'human_review', type: 'spike', humanReview: true, deletedAt: null }).where(eq(tasks.id, first.id))
    expect(await get(second.number)).toMatchObject({ waitingOnEpics: [{ id: a.id, title: a.title }] })
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${first.number}/approve`)).status).toBe(200)
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'task.updated', task: expect.objectContaining({ id: second.id, waitingOnEpics: [] }) }))
  })

  it('claims task and epic dependents of Approved designs, but never treats normal Approved or design Merged as done', async () => {
    const { project, a, first, second, dev } = await setup()
    await t.db.insert(schema.taskDependencies).values({ taskId: second.id, dependsOnId: first.id })
    const normal = await t.createTask(project.slug, { description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Normal work in the prerequisite epic' }] }] } })
    await t.db.update(tasks).set({ epicId: a.id, status: 'merged' }).where(eq(tasks.id, normal.id))
    const get = async () => (await t.request('GET', `/api/projects/${project.slug}/tasks/${second.number}`)).json()
    for (const [type, status] of [['design', 'human_review'], ['design', 'merged'], ['task', 'approved'], ['task', 'ready_to_merge']] as const) {
      await t.db.update(tasks).set({ type, status }).where(eq(tasks.id, first.id))
      expect(await get()).toMatchObject({ waitingOnEpics: [{ id: a.id }] })
      expect(await claimNextTask(t.db, dev.id, new Date(), [second.id])).toBeNull()
    }
    await t.db.update(tasks).set({ type: 'design', status: 'approved' }).where(eq(tasks.id, first.id))
    expect(await get()).toMatchObject({ waitingOnEpics: [] })
    expect(await claimNextTask(t.db, dev.id, new Date(), [second.id])).toMatchObject({ taskId: second.id, status: 'in_progress' })
  })

  it('edits dependencies through the API, audits and rejects cycles and task deadlocks atomically', async () => {
    const { project, a, b, first, second, dev } = await setup()
    const put = (id: string, dependsOn: string[]) => t.request('PUT', `/api/epics/${id}/dependencies`, { dependsOn })
    expect((await put(b.id, [])).status).toBe(200)
    const claim = await claimNextTask(t.db, dev.id, new Date(), [second.id])
    expect(claim?.taskId).toBe(second.id)
    await t.db.update(schema.runs).set({ state: 'completed' }).where(eq(schema.runs.id, claim!.runId))
    await t.db.update(tasks).set({ status: 'ready', leaseRunId: null, leaseRole: null, leaseExpiresAt: null }).where(eq(tasks.id, second.id))
    expect((await put(b.id, [a.id])).status).toBe(200)
    expect(await claimNextTask(t.db, dev.id, new Date(), [second.id])).toBeNull()
    const cycle = await put(a.id, [b.id])
    expect(cycle.status).toBe(400)
    expect(JSON.stringify(await cycle.json())).toContain('Foundation → Application → Foundation')
    expect((await t.request('GET', `/api/epics/${a.id}`)).status).toBe(200)
    expect(await (await t.request('GET', `/api/epics/${a.id}`)).json()).toMatchObject({ dependsOn: [], blocks: [b.id] })
    await put(b.id, [])
    await t.db.insert(schema.taskDependencies).values({ taskId: first.id, dependsOnId: second.id })
    const deadlock = await put(b.id, [a.id])
    expect(deadlock.status).toBe(400)
    const message = JSON.stringify(await deadlock.json())
    expect(message).toContain('Foundation')
    expect(message).toContain('Application')
    expect(await (await t.request('GET', `/api/epics/${b.id}`)).json()).toMatchObject({ dependsOn: [] })
    const other = await t.createProject()
    const [foreign] = await t.db.insert(epics).values({ projectId: other.id, title: 'Foreign', createdBy: t.actor }).returning()
    expect((await put(b.id, [foreign!.id])).status).toBe(400)
    expect((await put(b.id, [b.id])).status).toBe(400)
    const audits = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.projectId, project.id))
    expect(audits.filter(a => a.action === 'epic.updated')).toHaveLength(3)
  })

  it('blocks for every unfinished board state and permits Merged, Draft, Backlog, deleted and empty epics', async () => {
    const { first, second, dev } = await setup()
    for (const status of ['ready', 'in_progress', 'agent_review', 'human_review', 'ready_to_merge', 'blocked', 'failed'] as const) {
      await t.db.update(tasks).set({ status }).where(eq(tasks.id, first.id))
      expect(await claimNextTask(t.db, dev.id, new Date(), [second.id])).toBeNull()
    }
    for (const status of ['draft', 'backlog', 'merged'] as const) {
      await t.db.update(tasks).set({ status }).where(eq(tasks.id, first.id))
      const claim = await claimNextTask(t.db, dev.id, new Date(), [second.id])
      expect(claim?.taskId).toBe(second.id)
      await t.db.update(schema.runs).set({ state: 'completed' }).where(eq(schema.runs.id, claim!.runId))
      await t.db.update(tasks).set({ leaseRunId: null, leaseRole: null, leaseExpiresAt: null }).where(eq(tasks.id, second.id))
    }
    await t.db.update(tasks).set({ status: 'blocked', deletedAt: new Date() }).where(eq(tasks.id, first.id))
    expect((await claimNextTask(t.db, dev.id, new Date(), [second.id]))?.taskId).toBe(second.id)
  })

  it('keeps explicit task dependencies and leaves tasks without epics unaffected', async () => {
    const { project, first, second, dev, a } = await setup()
    const outside = await t.createTask(project.slug)
    await t.db.update(tasks).set({ status: 'ready' }).where(eq(tasks.id, outside.id))
    expect((await claimNextTask(t.db, dev.id, new Date(), [outside.id]))?.taskId).toBe(outside.id)
    await t.db.update(agents).set({ concurrency: 10 }).where(eq(agents.id, dev.id))
    await t.db.update(tasks).set({ status: 'merged' }).where(eq(tasks.id, first.id))
    await t.db.insert(schema.taskDependencies).values({ taskId: second.id, dependsOnId: outside.id })
    expect(await claimNextTask(t.db, dev.id, new Date(), [second.id])).toBeNull()
    await t.db.delete(schema.taskDependencies).where(eq(schema.taskDependencies.taskId, second.id))
    // Removing all tasks from A makes it done too.
    await t.db.delete(tasks).where(eq(tasks.id, first.id))
    expect((await claimNextTask(t.db, dev.id, new Date(), [second.id]))?.taskId).toBe(second.id)
    expect((await t.db.select().from(epics).where(eq(epics.id, a.id))).length).toBe(1)
  })

  it('wakes Ready tasks on removal through the API despite a wake interval', async () => {
    const { project, b, first, second, dev } = await setup()
    runner = await FakeRunner.connect(t.server!.url)
    await t.db.update(agents).set({ wakeIntervalSeconds: 3600 }).where(eq(agents.id, dev.id))
    await t.db.insert(schema.runs).values({ agentId: dev.id, projectId: project.id, taskId: first.id, role: 'developer', state: 'completed', queuedAt: t.clock.now })
    await t.orchestrator.schedule()
    expect((await t.db.select().from(tasks).where(eq(tasks.id, second.id)))[0]?.leaseRunId).toBeNull()
    const response = await t.request('PUT', `/api/epics/${b.id}/dependencies`, { dependsOn: [] })
    expect(response.status).toBe(200)
    await vi.waitFor(async () => {
      expect((await t.db.select().from(tasks).where(eq(tasks.id, second.id)))[0]?.leaseRunId).not.toBeNull()
    })
  })

  it('reports the same board-only progress used for completion', async () => {
    const { project, a, first } = await setup()
    await t.db.update(tasks).set({ status: 'merged' }).where(eq(tasks.id, first.id))
    for (const status of ['draft', 'backlog', 'blocked'] as const) {
      const extra = await t.createTask(project.slug)
      await t.db.update(tasks).set({ epicId: a.id, status, ...(status === 'blocked' && { deletedAt: new Date() }) }).where(eq(tasks.id, extra.id))
    }
    const response = await t.request('GET', `/api/projects/${project.slug}/epics`)
    expect(await response.json()).toContainEqual(expect.objectContaining({ id: a.id, taskCount: 1, mergedCount: 1 }))
  })

  it('cascades either end and enforces primary key and no-self constraints', async () => {
    const { a, b, second, dev } = await setup()
    await expect(t.db.insert(epicDependencies).values({ epicId: a.id, dependsOnEpicId: a.id })).rejects.toThrow()
    await expect(t.db.insert(epicDependencies).values({ epicId: b.id, dependsOnEpicId: a.id })).rejects.toThrow()
    await t.db.delete(epics).where(eq(epics.id, a.id))
    expect(await t.db.select().from(epicDependencies)).toEqual([])
    expect((await claimNextTask(t.db, dev.id))?.taskId).toBe(second.id)
    const [c] = await t.db.insert(epics).values({ projectId: b.projectId, title: 'Third', createdBy: t.actor }).returning()
    await t.db.insert(epicDependencies).values({ epicId: b.id, dependsOnEpicId: c!.id })
    await t.db.delete(epics).where(eq(epics.id, b.id))
    expect(await t.db.select().from(epicDependencies)).toEqual([])
  })

  it('wakes waiting epic tasks after the last merge despite a developer wake interval', async () => {
    const { project, first, second, dev } = await setup()
    runner = await FakeRunner.connect(t.server!.url)
    await t.db.update(agents).set({ wakeIntervalSeconds: 3600 }).where(eq(agents.id, dev.id))
    // A recent run puts this developer inside its wake interval.
    await t.db.insert(schema.runs).values({ agentId: dev.id, projectId: project.id, taskId: first.id, role: 'developer', state: 'completed', queuedAt: t.clock.now })
    t.github.setBranch(project.repository, 'fixture', 'abc')
    const pr = await t.github.openPullRequest(project.repository, { head: 'fixture', base: 'main', title: 'Foundation', body: '' })
    const live = t.github.pulls.get(pr.number)!
    live.merged = true
    live.mergeCommitSha = 'merged'
    await t.db.update(tasks).set({ status: 'ready_to_merge', prNumber: pr.number, headSha: 'abc' }).where(eq(tasks.id, first.id))
    await t.orchestrator.schedule()
    expect((await t.db.select().from(tasks).where(eq(tasks.id, second.id)))[0]?.leaseRunId).toBeNull()
    t.events.length = 0
    await t.orchestrator.merges.tick()
    await vi.waitFor(async () => {
      expect((await t.db.select().from(tasks).where(eq(tasks.id, second.id)))[0]?.leaseRunId).not.toBeNull()
    })
    expect(t.events).toContainEqual(expect.objectContaining({ type: 'task.updated', task: expect.objectContaining({ id: second.id }) }))
  })
})
