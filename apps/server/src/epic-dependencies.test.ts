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
