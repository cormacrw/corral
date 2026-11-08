import { EPIC_REVIEW_MODES, EPIC_REVIEW_STATES, hasPrToLand, holdsAcrossDeliveries, holdsDeliveryOpen, isUnfinished, parentHolds as parentHoldsTs, TASK_STATUSES, TASK_TYPES, type DeliveryRecord, type TaskStatus, type TaskType } from '@corral/core'
import { schema } from '@corral/db'
import { eq, sql, type SQL } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { holdsAcrossEpics, holdsEpicOpen, parentHolds, prToLand, unfinishedTask } from './delivery-sql.ts'
import { createTestApp, type TestApp } from './test-app.ts'

const { epics, tasks } = schema

let t: TestApp
beforeAll(async () => {
  t = await createTestApp('pglite')
})
afterAll(async () => t?.close())

const truth = (predicate: SQL) => sql<boolean>`coalesce(${predicate}, false)`

const deliveryShapes: DeliveryRecord[] = EPIC_REVIEW_MODES.flatMap(reviewMode => [null, 'corral/delivery'].flatMap(branch =>
  [null, ...EPIC_REVIEW_STATES].map(reviewState => ({ reviewMode, branch, reviewState }))))

const taskShapes = (statuses: readonly TaskStatus[]) => TASK_TYPES.flatMap((type: TaskType) => statuses.flatMap(status => [false, true].map(deleted => ({ type, status, deleted }))))

it('answers every delivery predicate in SQL as core does', async () => {
  const project = await t.createProject()
  let number = 0
  const deliveries = await t.db.insert(epics).values(deliveryShapes.map((d, i) => ({ projectId: project.id, title: `Delivery ${i}`, createdBy: t.actor, ...d }))).returning()
  const home = deliveries[0]!
  // Half of them in a task with subtasks, so a dependency's own delivery counts
  const shapes = taskShapes(TASK_STATUSES.filter(s => s !== 'parent')).flatMap(shape => [null, home.id].map(epicId => ({ ...shape, epicId })))
  await t.db.insert(tasks).values([...shapes, ...taskShapes(['parent'])].map(({ type, status, deleted, ...rest }) => ({
    projectId: project.id, number: ++number, title: 'Shape', type, status, createdBy: t.actor,
    epicId: 'epicId' in rest ? rest.epicId as string | null : null,
    statusReason: status === 'blocked' || status === 'failed' ? 'Shape' : null,
    deletedAt: deleted ? new Date() : null
  })))

  const pairs = await t.db.select({
    task: tasks, delivery: epics,
    unfinished: truth(unfinishedTask(tasks)),
    toLand: truth(prToLand(epics)),
    open: truth(holdsEpicOpen(tasks, epics)),
    across: truth(holdsAcrossEpics(tasks, epics, epics.id))
  }).from(tasks).crossJoin(epics).where(eq(tasks.projectId, project.id))
  expect(pairs.length).toBe(deliveries.length * (shapes.length + taskShapes(['parent']).length))
  for (const { task, delivery, ...sqlSays } of pairs) {
    const shape = { type: task.type, status: task.status, deleted: task.deletedAt !== null, epicId: task.epicId }
    expect(sqlSays, JSON.stringify({ shape, delivery })).toEqual({
      unfinished: isUnfinished(shape),
      toLand: hasPrToLand(delivery),
      open: holdsDeliveryOpen(shape, delivery),
      across: holdsAcrossDeliveries(shape, delivery, delivery.id)
    })
  }
})

it('answers whether a task with subtasks holds its dependents in SQL as core does', async () => {
  const project = await t.createProject()
  let number = 0
  const subtaskShapes = taskShapes(TASK_STATUSES.filter(s => s !== 'parent'))
  const holding = [
    { reviewMode: 'direct', branch: null, reviewState: null },
    { reviewMode: 'epic', branch: 'corral/delivery', reviewState: 'in_review' },
    { reviewMode: 'epic', branch: 'corral/delivery', reviewState: 'merged' }
  ] as const satisfies DeliveryRecord[]
  // One parent per delivery shape and subtask shape, and one with none
  const cases = [...holding.flatMap(delivery => subtaskShapes.map(sub => ({ delivery, subs: [sub] }))), { delivery: holding[0], subs: [] }]
  for (const { delivery, subs } of cases) {
    const [parent] = await t.db.insert(tasks).values({ projectId: project.id, number: ++number, title: 'Parent', type: 'task', status: 'parent', createdBy: t.actor }).returning()
    const [record] = await t.db.insert(epics).values({ projectId: project.id, taskId: parent!.id, title: 'Delivery', createdBy: t.actor, ...delivery }).returning()
    for (const sub of subs) {
      await t.db.insert(tasks).values({
        projectId: project.id, number: ++number, title: 'Subtask', type: sub.type, status: sub.status, epicId: record!.id, createdBy: t.actor,
        statusReason: sub.status === 'blocked' || sub.status === 'failed' ? 'Shape' : null, deletedAt: sub.deleted ? new Date() : null
      })
    }
    const [row] = await t.db.select({ holds: truth(parentHolds(t.db, tasks)) }).from(tasks).where(eq(tasks.id, parent!.id))
    expect(row!.holds, JSON.stringify({ delivery, subs })).toBe(parentHoldsTs(delivery, subs))
  }
})
