import { ACTIVE_RUN_STATES } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, eq, inArray } from 'drizzle-orm'

const { epics, runs } = schema

// Called in the task mutation transaction, before the new board membership
// becomes visible. The epic lock serializes this with claiming/reporting review.
export async function invalidateEpicReview(db: Executor, epicId: string | null): Promise<void> {
  if (!epicId) return
  const [epic] = await db.select().from(epics).where(eq(epics.id, epicId)).for('update')
  // Changes requested stands until the epic's fix work has merged
  if (!epic?.prNumber || epic.reviewState === 'merged' || epic.reviewState === 'changes_requested') return
  await db.update(epics).set({ reviewState: 'open', updatedAt: new Date() }).where(eq(epics.id, epicId))
  await db.update(runs).set({ state: 'interrupted', endedAt: new Date(), error: 'Epic board changed; integration review must run again' })
    .where(and(eq(runs.epicId, epicId), inArray(runs.state, [...ACTIVE_RUN_STATES])))
}
