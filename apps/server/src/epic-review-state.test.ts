import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { createTask } from './tasks.ts'
import { publishInvalidatedEpics } from './epic-review-state.ts'
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
  const invalidatedEpics = new Set<string>()
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
