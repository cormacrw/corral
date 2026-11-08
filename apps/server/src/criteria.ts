import { schema, type Executor } from '@corral/db'
import { asc, eq } from 'drizzle-orm'

const { acceptanceCriteria } = schema

// A task's criteria in its order. Positions can tie, so the id settles ties
// the same way on every screen and prompt.
export const CRITERIA_ORDER = [asc(acceptanceCriteria.position), asc(acceptanceCriteria.id)] as const

export function taskCriteria(db: Executor, taskId: string) {
  return db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, taskId)).orderBy(...CRITERIA_ORDER)
}
