import { ACTIVE_RUN_STATES } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, eq, inArray, isNotNull, isNull, ne, notInArray, or, type SQL } from 'drizzle-orm'
import type { AnyPgColumn } from 'drizzle-orm/pg-core'

const { epics, runs } = schema

// True for a board task that keeps its epic from being done (D22, D23). An
// epic with a branch is done when its PR has merged; a `direct` epic, or one
// that never needed a branch, when its board tasks have. Join tasks to epics.
export function holdsEpicOpen(task: { deletedAt: AnyPgColumn, status: AnyPgColumn }, epic: { reviewMode: AnyPgColumn, branch: AnyPgColumn, reviewState: AnyPgColumn }): SQL {
  return and(
    isNull(task.deletedAt),
    notInArray(task.status, ['draft', 'backlog']),
    or(
      ne(task.status, 'merged'),
      and(ne(epic.reviewMode, 'direct'), isNotNull(epic.branch), or(isNull(epic.reviewState), ne(epic.reviewState, 'merged')))
    )
  )!
}

// Called in the task mutation transaction, before the new board membership
// becomes visible. The epic lock serializes this with claiming/reporting review.
export async function invalidateEpicReview(db: Executor, epicId: string | null): Promise<void> {
  if (!epicId) return
  const [epic] = await db.select().from(epics).where(eq(epics.id, epicId)).for('update')
  // Changes requested stands until the epic's fix work has merged
  if (!epic?.prNumber || epic.reviewState === 'merged' || epic.reviewState === 'changes_requested') return
  await db.update(epics).set({ reviewState: 'open', rebaseRequested: false, conflictFiles: null, updatedAt: new Date() }).where(eq(epics.id, epicId))
  await db.update(runs).set({ state: 'interrupted', endedAt: new Date(), error: 'Epic board changed; integration review must run again' })
    .where(and(eq(runs.epicId, epicId), inArray(runs.state, [...ACTIVE_RUN_STATES])))
}
