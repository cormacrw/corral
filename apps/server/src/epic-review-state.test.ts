import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createTask, transitionTask } from './tasks.ts'
import { publishInvalidatedEpics, type InvalidatedEpics } from './epic-review-state.ts'
import { createTestApp, type TestApp } from './test-app.ts'

let t: TestApp
beforeEach(async () => {
  t = await createTestApp('pglite')
})
afterEach(async () => t?.close())

async function setup() {
  const project = await t.createProject()
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  const epics = await t.db.insert(schema.epics).values(
    ['human_review', 'ready_to_merge'].map((reviewState, i) => ({
      projectId: project.id, title: `Review ${i}`, createdBy: t.actor,
      reviewState: reviewState as 'human_review' | 'ready_to_merge',
      branch: `epic-${i}`, prNumber: i + 1
    }))
  ).returning()
  return { project, first: epics[0]!, second: epics[1]! }
}

it('publishes the committed epic review reset when Backlog work becomes Ready', async () => {
  const { project, first } = await setup()
  const task = await t.createTask(project.slug, { epicId: first.id })
  expect(t.events.filter(e => e.type === 'epic.updated')).toEqual([])
  const committed: Promise<string | null>[] = []
  const unsubscribe = t.bus.subscribe((event) => {
    if (event.type === 'epic.updated') {
      committed.push(t.db.select().from(schema.epics).where(eq(schema.epics.id, event.epic.id))
        .then(rows => rows[0]!.reviewState))
    }
  })
  const response = await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
  unsubscribe()
  expect(response.status).toBe(200)
  expect(t.events.filter(e => e.type === 'epic.updated')).toMatchObject([
    { epic: { id: first.id, reviewState: 'open', taskCount: 1 } }
  ])
  expect(await Promise.all(committed)).toEqual(['open'])
})

it('publishes both epic resets when a board task moves between epics', async () => {
  const { project, first, second } = await setup()
  const task = await t.createTask(project.slug, { epicId: first.id })
  await t.db.update(schema.tasks).set({ status: 'ready' }).where(eq(schema.tasks.id, task.id))
  const response = await t.request('PATCH', `/api/projects/${project.slug}/tasks/${task.number}`, { epicId: second.id })
  expect(response.status).toBe(200)
  expect(t.events.filter(e => e.type === 'epic.updated')).toMatchObject([
    { epic: { id: first.id, reviewState: 'open', taskCount: 0 } },
    { epic: { id: second.id, reviewState: 'open', taskCount: 1 } }
  ])
})

it('publishes no reset when the task edit rolls back', async () => {
  const { project, first, second } = await setup()
  const task = await t.createTask(project.slug, { epicId: first.id })
  await t.db.update(schema.tasks).set({ status: 'ready' }).where(eq(schema.tasks.id, task.id))
  const response = await t.request('PATCH', `/api/projects/${project.slug}/tasks/${task.number}`, { epicId: second.id, dependsOn: [999] })
  expect(response.status).toBe(400)
  expect(t.events.filter(e => e.type === 'epic.updated')).toEqual([])
  const rows = await t.db.select().from(schema.epics)
  expect(rows.map(e => e.reviewState)).toEqual(['human_review', 'ready_to_merge'])
})

it('collects and publishes a reset for a task created directly on the board', async () => {
  const { project, first } = await setup()
  const [row] = await t.db.select().from(schema.projects).where(eq(schema.projects.id, project.id))
  const invalidatedEpics: InvalidatedEpics = new Map()
  await createTask(t.db, row!, {
    title: 'New board work', type: 'task', description: null, priority: 'medium',
    epicId: first.id, dependsOn: [], acceptanceCriteria: []
  }, t.actor, { epicFix: true, invalidatedEpics })
  expect(t.events.filter(e => e.type === 'epic.updated')).toEqual([])
  await publishInvalidatedEpics(t.db, t.bus, invalidatedEpics)
  expect(t.events.filter(e => e.type === 'epic.updated')).toMatchObject([
    { epic: { id: first.id, reviewState: 'open', taskCount: 1 } }
  ])
})

async function activeReview(epicId: string, projectId: string) {
  const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'reviewer'))
  const [run] = await t.db.insert(schema.runs).values({ agentId: agent!.id, projectId, epicId, role: 'reviewer', state: 'running' }).returning()
  return run!
}

const interrupted = () => t.events.flatMap(e => e.type === 'run.updated' ? [{ id: e.run.id, state: e.run.state }] : [])

it('publishes the interrupted review run once the task move has committed, with no runner acknowledgement', async () => {
  const { project, first } = await setup()
  const task = await t.createTask(project.slug, { epicId: first.id })
  const run = await activeReview(first.id, project.id)
  const committed: Promise<string>[] = []
  const unsubscribe = t.bus.subscribe((event) => {
    if (event.type === 'run.updated') {
      committed.push(t.db.select().from(schema.runs).where(eq(schema.runs.id, event.run.id)).then(rows => rows[0]!.state))
    }
  })
  const response = await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
  unsubscribe()
  expect(response.status).toBe(200)
  expect(interrupted()).toEqual([{ id: run.id, state: 'interrupted' }])
  expect(await Promise.all(committed)).toEqual(['interrupted'])
})

it('publishes interrupted runs from both epics when a board task moves between them', async () => {
  const { project, first, second } = await setup()
  const task = await t.createTask(project.slug, { epicId: first.id })
  await t.db.update(schema.tasks).set({ status: 'ready' }).where(eq(schema.tasks.id, task.id))
  const runs = [await activeReview(first.id, project.id), await activeReview(second.id, project.id)]
  const response = await t.request('PATCH', `/api/projects/${project.slug}/tasks/${task.number}`, { epicId: second.id })
  expect(response.status).toBe(200)
  expect(interrupted()).toEqual(runs.map(run => ({ id: run.id, state: 'interrupted' })))
})

it('keeps every interrupted run when one transaction invalidates an epic twice', async () => {
  const { project, first } = await setup()
  const tasks = [await t.createTask(project.slug, { epicId: first.id }), await t.createTask(project.slug, { epicId: first.id })]
  const run = await activeReview(first.id, project.id)
  const invalidatedEpics: InvalidatedEpics = new Map()
  await t.db.transaction(async (tx) => {
    for (const task of tasks) await transitionTask(tx, task.id, { type: 'approve' }, t.actor, invalidatedEpics)
  })
  expect(t.events.filter(e => e.type === 'run.updated')).toEqual([])
  await publishInvalidatedEpics(t.db, t.bus, invalidatedEpics)
  expect(interrupted()).toEqual([{ id: run.id, state: 'interrupted' }])
})

it('leaves the review run active and unpublished when the task edit rolls back', async () => {
  const { project, first, second } = await setup()
  const task = await t.createTask(project.slug, { epicId: first.id })
  await t.db.update(schema.tasks).set({ status: 'ready' }).where(eq(schema.tasks.id, task.id))
  const run = await activeReview(first.id, project.id)
  const response = await t.request('PATCH', `/api/projects/${project.slug}/tasks/${task.number}`, { epicId: second.id, dependsOn: [999] })
  expect(response.status).toBe(400)
  expect(interrupted()).toEqual([])
  const [row] = await t.db.select().from(schema.runs).where(eq(schema.runs.id, run.id))
  expect(row!.state).toBe('running')
})

it('publishes the interrupted review run after Plan approval commits', async () => {
  const { project, first } = await setup()
  const task = await t.createTask(project.slug, { epicId: first.id })
  const run = await activeReview(first.id, project.id)
  const [session] = await t.db.insert(schema.planSessions).values({ projectId: project.id, title: 'More work', createdBy: t.actor }).returning()
  const [plan] = await t.db.insert(schema.plans).values({ sessionId: session!.id, projectId: project.id, epicId: first.id, version: 1, title: 'More work' }).returning()
  await t.db.insert(schema.planEpics).values({ planId: plan!.id, epicId: first.id, key: 'e1', position: 0 })
  await t.db.insert(schema.planTasks).values({ planId: plan!.id, taskId: task.id, key: 't1', change: 'added', position: 0 })
  const response = await t.request('POST', `/api/plan/plans/${plan!.id}/approve`, { to: 'ready' })
  expect(response.status).toBe(200)
  expect(interrupted()).toEqual([{ id: run.id, state: 'interrupted' }])
})

it('publishes a review run the epic rebase hand-off interrupts', async () => {
  const { project, first } = await setup()
  await t.db.update(schema.epics).set({ reviewState: 'conflict', prHeadSha: 'abc123' }).where(eq(schema.epics.id, first.id))
  const run = await activeReview(first.id, project.id)
  const response = await t.request('POST', `/api/epics/${first.id}/review`, { action: 'rebase', headSha: 'abc123' })
  expect(response.status).toBe(200)
  expect(t.events.filter(e => e.type === 'epic.updated')).toMatchObject([{ epic: { id: first.id, reviewState: 'open' } }])
  expect(interrupted()).toEqual([{ id: run.id, state: 'interrupted' }])
})
