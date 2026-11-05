import type { Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { claimNextTask } from './claim.ts'
import { publishEpicDependents } from './dependent-tasks.ts'
import { deleteTaskRows, patchTask } from './tasks.ts'
import { createTestApp, type TestApp } from './test-app.ts'

const { acceptanceCriteria, agents, epics, runs, taskDependencies, tasks } = schema

describe('tasks with subtasks', () => {
  let t: TestApp
  beforeAll(async () => {
    t = await createTestApp('pglite')
  })
  afterEach(async () => {
    await t.orchestrator.schedule()
    await t.db.delete(schema.projects)
  })
  afterAll(async () => {
    await t?.close()
  })

  const api = (path: string) => t.request('GET', path).then(r => r.json()) as Promise<Task>

  // A parent with two sub-tasks, and a task that depends on the parent
  async function setup(reviewMode: 'epic' | 'direct' = 'epic') {
    const project = await t.createProject({ repository: 'cormacrw/test-app', defaultBranch: 'main' })
    const [delivery] = await t.db.insert(epics).values({ projectId: project.id, title: 'Search', description: 'Find things', reviewMode, createdBy: t.actor }).returning()
    const created = async () => {
      const res = await t.request('POST', `/api/projects/${project.slug}/tasks`, { title: 'Sub-task', type: 'task', epicId: delivery!.id, acceptanceCriteria: ['It works'] })
      return await res.json() as Task
    }
    const a = await created()
    const b = await created()
    const [row] = await t.db.select().from(epics).where(eq(epics.id, delivery!.id))
    const waiting = await t.createTask(project.slug)
    await t.db.insert(taskDependencies).values({ projectId: project.id, taskId: waiting.id, dependsOnId: row!.taskId! })
    await t.db.update(tasks).set({ status: 'ready' }).where(eq(tasks.id, waiting.id))
    const [developer] = await t.db.select().from(agents).where(eq(agents.role, 'developer'))
    return { project, delivery: row!, parentId: row!.taskId!, a, b, waiting, developer: developer! }
  }
  const claimable = async (taskId: string, agent: typeof agents.$inferSelect) => {
    await t.db.update(agents).set({ concurrency: 50 }).where(eq(agents.id, agent.id))
    return await claimNextTask(t.db, agent.id, new Date(), [taskId]) !== null
  }
  const setSub = (id: string, status: 'merged' | 'in_progress' | 'backlog' | 'blocked', extra = {}) => t.db.update(tasks).set({ status, statusReason: status === 'blocked' ? 'Waiting' : null, ...extra }).where(eq(tasks.id, id))

  describe('dependency waits', () => {
    it('keeps a dependent unclaimed until the task\'s work is on the target branch, then starts it', async () => {
      const { project, delivery, a, b, waiting, developer } = await setup()
      expect(await api(`/api/projects/${project.slug}/tasks/${waiting.number}`)).toMatchObject({ waitingOnEpics: [{ id: delivery.id }] })
      // Unstarted sub-tasks hold it too: nothing has landed
      expect(await claimable(waiting.id, developer)).toBe(false)
      await setSub(a.id, 'in_progress')
      expect(await claimable(waiting.id, developer)).toBe(false)
      await setSub(a.id, 'merged')
      await setSub(b.id, 'merged')
      // Every sub-task merged into the epic branch: the epic PR hasn't merged
      await t.db.update(epics).set({ branch: 'corral/epic-x', reviewState: 'human_review' }).where(eq(epics.id, delivery.id))
      expect(await claimable(waiting.id, developer)).toBe(false)
      await t.db.update(epics).set({ reviewState: 'merged' }).where(eq(epics.id, delivery.id))
      expect(await api(`/api/projects/${project.slug}/tasks/${waiting.number}`)).toMatchObject({ waitingOnEpics: [] })
      expect(await publishEpicDependents(t.db, t.bus, delivery.id)).toContain(waiting.id)
      expect(await claimable(waiting.id, developer)).toBe(true)
    })

    it('releases a dependent of a direct task when its subtasks finish', async () => {
      const { delivery, a, b, waiting, developer } = await setup('direct')
      await setSub(a.id, 'merged')
      await setSub(b.id, 'in_progress')
      expect(await claimable(waiting.id, developer)).toBe(false)
      await setSub(b.id, 'merged')
      expect(delivery.reviewMode).toBe('direct')
      expect(await claimable(waiting.id, developer)).toBe(true)
    })

    it('doesn\'t wait forever on a task with no live subtasks', async () => {
      const { a, b, waiting, developer } = await setup()
      await t.db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, a.id))
      await t.db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, b.id))
      expect(await claimable(waiting.id, developer)).toBe(true)
    })
  })

  describe('the engine', () => {
    it('never claims a task, and lists it nowhere work is listed', async () => {
      const { project, parentId, developer } = await setup()
      expect(await claimable(parentId, developer)).toBe(false)
      const inbox = await t.request('GET', '/api/inbox').then(r => r.json()) as { needsYou: { taskId?: string }[] }
      expect(inbox.needsYou.some(i => i.taskId === parentId)).toBe(false)
      await t.mergePass()
      expect((await t.db.select().from(tasks).where(eq(tasks.id, parentId)))[0]).toMatchObject({ status: 'parent', leaseRunId: null })
      expect(await t.db.select().from(runs).where(eq(runs.taskId, parentId))).toEqual([])
      const prs = await t.request('GET', `/api/projects/${project.slug}/pull-requests`).then(r => r.json()) as { taskId?: string }[]
      expect(prs.some(p => p.taskId === parentId)).toBe(false)
      const flow = await t.request('GET', `/api/projects/${project.slug}/metrics/flow`)
      expect(flow.status).toBeLessThan(500)
    })

    it('rolls a task up from its subtasks on read', async () => {
      const { project, parentId, delivery, a, b } = await setup()
      const parent = (await t.db.select().from(tasks).where(eq(tasks.id, parentId)))[0]!
      const read = () => api(`/api/projects/${project.slug}/tasks/${parent.number}`)
      expect(await read()).toMatchObject({ status: 'parent', parentTask: null, epicId: null, rollup: { epicId: delivery.id, stage: 'ready', done: 0, total: 2, planned: false } })
      await setSub(a.id, 'in_progress')
      expect(await read()).toMatchObject({ rollup: { stage: 'in_progress', done: 0, total: 2, planned: true } })
      await setSub(a.id, 'blocked')
      expect(await read()).toMatchObject({ rollup: { stage: 'blocked' } })
      await setSub(a.id, 'merged')
      await setSub(b.id, 'merged')
      await t.db.update(epics).set({ branch: 'corral/epic-x', prNumber: 4, reviewState: 'merged', mergedAt: new Date('2026-05-01T00:00:00Z') }).where(eq(epics.id, delivery.id))
      expect(await read()).toMatchObject({ pr: { number: 4 }, mergedAt: '2026-05-01T00:00:00.000Z', rollup: { stage: 'done', done: 2 } })
      expect(await api(`/api/projects/${project.slug}/tasks/${a.number}`)).toMatchObject({ parentTask: { id: parentId, title: 'Search' } })
      expect(await t.request('GET', `/api/projects/${project.slug}/tasks?view=board`).then(r => r.json())).toEqual(expect.arrayContaining([expect.objectContaining({ id: parentId })]))
    })

    it('keeps a task of Backlog work off the Board, and one of Drafts in its plan', async () => {
      const { project, parentId, a, b } = await setup()
      const ids = async (view: string) => (await t.request('GET', `/api/projects/${project.slug}/tasks?view=${view}`).then(r => r.json()) as Task[]).map(task => task.id)
      expect(await ids('board')).not.toContain(parentId)
      expect(await ids('backlog')).toContain(parentId)
      await t.db.update(tasks).set({ status: 'draft' }).where(and(eq(tasks.projectId, project.id), eq(tasks.id, a.id)))
      await t.db.update(tasks).set({ status: 'draft' }).where(and(eq(tasks.projectId, project.id), eq(tasks.id, b.id)))
      expect(await ids('backlog')).not.toContain(parentId)
    })
  })

  describe('refusals', () => {
    it('refuses status changes, criteria and delivery fields on a task', async () => {
      const { project, parentId } = await setup()
      const [parent] = await t.db.select().from(tasks).where(eq(tasks.id, parentId))
      const path = `/api/projects/${project.slug}/tasks/${parent!.number}`
      expect((await t.request('POST', `${path}/transitions`, { type: 'approve' })).status).toBe(409)
      expect((await t.request('PATCH', path, { acceptanceCriteria: [{ text: 'Nope' }] })).status).toBe(409)
      expect((await t.request('PATCH', path, { humanReview: true })).status).toBe(409)
      expect((await t.request('PATCH', path, { type: 'bug' })).status).toBe(409)
      expect((await t.request('PATCH', path, { dependsOn: [] })).status).toBe(409)
      expect((await t.db.select().from(tasks).where(eq(tasks.id, parentId)))[0]).toMatchObject({ status: 'parent' })
    })

    it('carries a task\'s title to its delivery record, and back', async () => {
      const { project, parentId, delivery } = await setup()
      const [parent] = await t.db.select().from(tasks).where(eq(tasks.id, parentId))
      await patchTask(t.db, project as never, parentId, { title: 'Renamed' }, t.actor)
      expect((await t.db.select().from(epics).where(eq(epics.id, delivery.id)))[0]).toMatchObject({ title: 'Renamed' })
      await t.request('PATCH', `/api/epics/${delivery.id}`, { title: 'Again' })
      expect((await t.db.select().from(tasks).where(eq(tasks.id, parent!.id)))[0]).toMatchObject({ title: 'Again' })
    })

    it('deletes an empty task with its delivery record, and refuses one with subtasks', async () => {
      const { parentId, delivery, a, b } = await setup()
      await expect(deleteTaskRows(t.db, parentId, t.actor, null)).rejects.toThrow()
      await t.db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, a.id))
      await t.db.update(tasks).set({ deletedAt: new Date() }).where(eq(tasks.id, b.id))
      await deleteTaskRows(t.db, parentId, t.actor, null)
      expect(await t.db.select().from(tasks).where(eq(tasks.id, parentId))).toEqual([])
      expect(await t.db.select().from(epics).where(eq(epics.id, delivery.id))).toEqual([])
    })
  })

  describe('promotion', () => {
    it('makes a task of an unstarted task: same ref and comments, criteria and dependencies move', async () => {
      const project = await t.createProject({ repository: 'cormacrw/test-app', defaultBranch: 'main' })
      const other = await t.createTask(project.slug)
      const res = await t.request('POST', `/api/projects/${project.slug}/tasks`, { title: 'Big one', type: 'task', humanReview: true, dependsOn: [other.number], acceptanceCriteria: ['Moves', { text: 'Human looks', checkedByHuman: true }] })
      const big = await res.json() as Task
      await t.request('POST', `/api/projects/${project.slug}/tasks/${big.number}/comments`, { body: 'Keep me', pinned: false })
      const made = await t.request('POST', `/api/projects/${project.slug}/tasks/${big.number}/subtasks`, { title: 'Part one', type: 'task', acceptanceCriteria: ['Own'] })
      expect(made.status).toBe(201)
      const sub = await made.json() as Task
      expect(sub).toMatchObject({ parentTask: { id: big.id, ref: big.ref }, humanReview: true, status: 'backlog', dependsOn: [other.ref] })
      expect(sub.acceptanceCriteria.map(c => [c.text, c.checkedByHuman])).toEqual([['Own', false], ['Moves', false], ['Human looks', true]])
      const parent = await api(`/api/projects/${project.slug}/tasks/${big.number}`)
      expect(parent).toMatchObject({ status: 'parent', ref: big.ref, humanReview: false, dependsOn: [], acceptanceCriteria: [], rollup: { total: 1 } })
      expect(await t.db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, big.id))).toEqual([])
      expect(await t.request('GET', `/api/projects/${project.slug}/tasks/${big.number}/comments`).then(r => r.json())).toEqual([expect.objectContaining({ body: 'Keep me' })])
    })

    it('refuses a task with a run, lease or PR, a pinned one, and a subtask', async () => {
      const { project, a } = await setup()
      const add = (number: number) => t.request('POST', `/api/projects/${project.slug}/tasks/${number}/subtasks`, { title: 'More', type: 'task' })
      expect((await add(a.number)).status).toBe(409)
      const started = await t.createTask(project.slug)
      await t.db.update(tasks).set({ status: 'in_progress' }).where(eq(tasks.id, started.id))
      const refused = await add(started.number)
      expect(refused.status).toBe(409)
      expect(JSON.stringify(await refused.json())).toContain('follow-up')
    })
  })
})
