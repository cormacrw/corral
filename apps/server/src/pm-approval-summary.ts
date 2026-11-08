import { schema, type Database } from '@corral/db'
import { and, eq } from 'drizzle-orm'
import { CRITERIA_ORDER } from './criteria.ts'

const { acceptanceCriteria } = schema

// The task's criteria a human checks, in order
export async function heldHumanChecks(db: Database, taskId: string): Promise<{ id: string, text: string, checkedByHuman: boolean }[]> {
  return db.select({ id: acceptanceCriteria.id, text: acceptanceCriteria.text, checkedByHuman: acceptanceCriteria.checkedByHuman }).from(acceptanceCriteria)
    .where(and(eq(acceptanceCriteria.taskId, taskId), eq(acceptanceCriteria.checkedByHuman, true)))
    .orderBy(...CRITERIA_ORDER)
}

// D28: Confirm explicitly attests to the current human checks. Re-preparing
// this suffix also invalidates a card when those checks change (D30).
export async function humanApprovalSummary(db: Database, taskId: string): Promise<string> {
  const criteria = await heldHumanChecks(db, taskId)
  return criteria.length ? `. Confirming says you checked: ${criteria.map(criterion => criterion.text).join('; ')}` : ''
}
