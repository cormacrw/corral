import { ACTIVE_RUN_STATES } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'
import { getEpic } from './epics.ts'
import type { EventBus } from './events.ts'
import { unfinishedTask } from './completion.ts'
import { runEndValues } from './run-lifecycle.ts'
import { getRun } from './runs.ts'

const { epics, runs } = schema

// True for a board task that keeps its epic from being done (D22, D27). An
// epic with a branch is done when its PR has merged; a `direct` epic, or one
// that never needed a branch, when its board tasks have. Join tasks to epics.
export function holdsEpicOpen(task: { deletedAt: AnyPgColumn, status: AnyPgColumn, type: AnyPgColumn }, epic: { reviewMode: AnyPgColumn, branch: AnyPgColumn, reviewState: AnyPgColumn }): SQL {
  return and(
    isNull(task.deletedAt),
    notInArray(task.status, ['draft', 'backlog']),
    or(
      unfinishedTask(task),
      and(ne(epic.reviewMode, 'direct'), isNotNull(epic.branch), or(isNull(epic.reviewState), ne(epic.reviewState, 'merged')))
    )
  )!
}

// Epics whose review a mutation reset, with the runs that reset interrupted
export type InvalidatedEpics = Map<string, string[]>

// Called in the task mutation transaction, before the new board membership
// becomes visible. The epic lock serializes this with claiming/reporting review.
export async function invalidateEpicReview(db: Executor, epicId: string | null, invalidated?: InvalidatedEpics): Promise<void> {
  if (!epicId) return
  const [epic] = await db.select().from(epics).where(eq(epics.id, epicId)).for('update')
  // Changes requested stands until the epic's fix work has merged
  if (!epic?.prNumber || epic.reviewState === 'merged' || epic.reviewState === 'changes_requested') return
  await db.update(epics).set({ reviewState: 'open', rebaseRequested: false, conflictFiles: null, updatedAt: new Date() }).where(eq(epics.id, epicId))
  const interrupted = await db.update(runs).set(runEndValues({ state: 'interrupted', error: 'Epic board changed; integration review must run again' }, new Date()))
    .where(and(eq(runs.epicId, epicId), inArray(runs.state, [...ACTIVE_RUN_STATES])))
    .returning({ id: runs.id })
  invalidated?.set(epicId, [...invalidated.get(epicId) ?? [], ...interrupted.map(run => run.id)])
}

// Flush only after the enclosing transaction commits, never from a savepoint.
export async function publishInvalidatedEpics(db: Executor, events: EventBus, invalidated: InvalidatedEpics): Promise<void> {
  for (const [id, runIds] of invalidated) {
    events.publish({ type: 'epic.updated', epic: await getEpic(db, id) })
    for (const runId of runIds) events.publish({ type: 'run.updated', run: await getRun(db, runId) })
  }
}
