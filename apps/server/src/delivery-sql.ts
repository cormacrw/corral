import { CODE_TASK_TYPES, DONE_STATUS, PRE_BOARD_STATUSES } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, eq, exists, inArray, isNotNull, isNull, ne, not, notInArray, or, sql, type SQL } from 'drizzle-orm'
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core'

// The SQL forms of core's delivery predicates (parent.ts, completion.ts), for
// queries that filter on them. delivery-sql.test.ts holds each to its core twin.

const { epics, tasks } = schema

type TaskColumns = { type: AnyPgColumn, status: AnyPgColumn }
type LiveTaskColumns = TaskColumns & { deletedAt: AnyPgColumn }
type DeliveryColumns = { reviewMode: AnyPgColumn, branch: AnyPgColumn, reviewState: AnyPgColumn }

// isUnfinished
export function unfinishedTask(task: TaskColumns): SQL {
  return and(ne(task.status, 'parent'), not(or(...Object.entries(DONE_STATUS).map(([type, status]) =>
    and(eq(task.type, type), eq(task.status, status))
  ))!))!
}

// hasPrToLand
export function prToLand(delivery: DeliveryColumns): SQL {
  return and(ne(delivery.reviewMode, 'direct'), isNotNull(delivery.branch), or(isNull(delivery.reviewState), ne(delivery.reviewState, 'merged')))!
}

// holdsDeliveryOpen. Join tasks to epics.
export function holdsEpicOpen(task: LiveTaskColumns, delivery: DeliveryColumns): SQL {
  return and(isNull(task.deletedAt), notInArray(task.status, [...PRE_BOARD_STATUSES]), or(unfinishedTask(task), prToLand(delivery)))!
}

// holdsAcrossDeliveries. Left join epics to the dependency.
export function holdsAcrossEpics(dependency: LiveTaskColumns & { epicId: AnyPgColumn }, delivery: DeliveryColumns & { id: AnyPgColumn }, dependentEpicId: AnyPgColumn): SQL {
  return and(
    inArray(dependency.type, [...CODE_TASK_TYPES]),
    isNotNull(delivery.id),
    sql`${dependency.epicId} is distinct from ${dependentEpicId}`,
    holdsEpicOpen(dependency, delivery)
  )!
}

// parentHolds, for a dependency that is a task with subtasks
export function parentHolds(db: Executor, dependency: { id: AnyPgColumn, status: AnyPgColumn }): SQL {
  const delivery = alias(epics, 'parent_delivery')
  const sub = alias(tasks, 'parent_sub')
  const holding = db.select({ one: sql`1` }).from(sub).where(and(
    eq(sub.epicId, delivery.id),
    or(and(isNull(sub.deletedAt), unfinishedTask(sub)), holdsEpicOpen(sub, delivery))
  ))
  return and(eq(dependency.status, 'parent'), exists(db.select({ one: sql`1` }).from(delivery).where(and(
    eq(delivery.taskId, dependency.id),
    exists(holding)
  ))))!
}
