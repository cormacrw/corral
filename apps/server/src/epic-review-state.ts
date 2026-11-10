import { schema, type Executor } from '@corral/db'
import { eq } from 'drizzle-orm'
import { endActiveRuns } from './run-lifecycle.ts'

const { epics, runs } = schema

// Epics whose review a mutation reset, with the runs that reset interrupted
export type InvalidatedEpics = Map<string, string[]>

// Called in the task mutation transaction, before the new board membership
// becomes visible. The epic lock serializes this with claiming/reporting review.
export async function invalidateEpicReview(db: Executor, epicId: string | null, invalidated?: InvalidatedEpics): Promise<void> {
  if (!epicId) return
  const [epic] = await db.select().from(epics).where(eq(epics.id, epicId)).for('update')
  // Changes requested stands until the epic's fix work has merged
  if (!epic?.prNumber || epic.reviewState === 'merged' || epic.reviewState === 'changes_requested') return
  await db.update(epics).set({ reviewState: 'open', approvedHeadSha: null, approvedBaseSha: null, updatedAt: new Date() }).where(eq(epics.id, epicId))
  const interrupted = await endActiveRuns(db, eq(runs.epicId, epicId), { state: 'interrupted', error: 'Task board changed; integration review must run again' }, new Date())
  invalidated?.set(epicId, [...invalidated.get(epicId) ?? [], ...interrupted])
}
