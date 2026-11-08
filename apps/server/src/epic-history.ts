import { epicPrEventLabel, type EpicHistoryEntry } from '@corral/contracts'
import { actorLabel } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, eq, sql } from 'drizzle-orm'
import { actorNames } from './actor-names.ts'
import { auditText, readAudit, type AuditView } from './audit.ts'

const { auditLog } = schema

// An epic PR event as one line, for the Inbox and the epic's history
export const epicEventText = (detail: AuditView) => [epicPrEventLabel(detail.event, detail.fix), detail.summary].filter(Boolean).join(': ')

export async function epicHistory(db: Executor, epicId: string): Promise<EpicHistoryEntry[]> {
  const rows = await db.select().from(auditLog).where(and(eq(auditLog.action, 'epic.pr'), sql`${auditText('epic.pr', 'epicId')} = ${epicId}`)).orderBy(asc(auditLog.createdAt), asc(auditLog.id))
  const nameOf = await actorNames(db, rows.map(r => r.actor))
  return rows.map((row) => {
    const detail = readAudit(row.detail)
    const actor = (row.actor.kind === 'agent' && nameOf(row.actor)) || actorLabel(row.actor)
    return { id: String(row.id), at: row.createdAt.toISOString(), actor, event: detail.event ?? '', text: epicEventText(detail), detail: row.detail as Record<string, unknown> }
  })
}
