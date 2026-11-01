import { schema, type Database } from '@corral/db'
import { and, asc, eq } from 'drizzle-orm'

// D28: Confirm explicitly attests to the current human checks. Re-preparing
// this suffix also invalidates a card when those checks change (D29).
export async function humanApprovalSummary(db: Database, taskId: string): Promise<string> {
  const criteria = await db.select({ text: schema.acceptanceCriteria.text }).from(schema.acceptanceCriteria)
    .where(and(eq(schema.acceptanceCriteria.taskId, taskId), eq(schema.acceptanceCriteria.checkedByHuman, true)))
    .orderBy(asc(schema.acceptanceCriteria.position), asc(schema.acceptanceCriteria.id))
  return criteria.length ? `. Confirming says you checked: ${criteria.map(criterion => criterion.text).join('; ')}` : ''
}
