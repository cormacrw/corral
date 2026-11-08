import type { AuditAction, AuditDetails, AuditEntry, AuditEvent } from '@corral/contracts'
import type { Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { asc, eq, sql, type SQL } from 'drizzle-orm'
import { actorNames } from './actor-names.ts'

const { auditLog } = schema

type Single<A, Whole = A> = A extends unknown ? ([Whole] extends [A] ? A : never) : never

// Takes one action at a time: an action chosen by a ternary would otherwise
// accept the detail of either side.
export function auditEvent<A extends AuditAction>(action: A & Single<A>, detail: AuditDetails[A]): AuditEvent {
  return { action, detail } as AuditEvent
}

// The only way an entry reaches the audit log, which is append-only (D1)
export async function appendAudit(db: Executor, scope: { projectId?: string | null, taskId?: string | null, actor: Actor }, event: AuditEvent): Promise<void> {
  await db.insert(auditLog).values({ ...scope, ...event })
}

// A detail key as text in a query, checked against what its action stores
export function auditText<A extends AuditAction>(_action: A, key: keyof AuditDetails[A] & string): SQL<string | null> {
  return sql`${auditLog.detail}->>${sql.raw(`'${key}'`)}`
}

export interface AuditView {
  event: string | null
  headSha?: string | null
  to: string | null
  verdict?: string
  met?: number
  of?: number
  version?: number
  summary?: string
  feedback?: string
  fixTasks?: { id: string, ref: string, title: string }[]
  integratedCommitSha?: string
  fix?: string
}

// Reads a stored detail, whatever its age. `event` was written as a name by
// most producers and as the human's whole input by others, sometimes with
// the target status only inside it. Rows are never rewritten, so both stay.
export function readAudit(detail: unknown): AuditView {
  const stored = (detail ?? {}) as Omit<AuditView, 'event' | 'to'> & { event?: unknown, to?: string }
  const event = typeof stored.event === 'object' ? stored.event as { type?: string, to?: string, feedback?: string } | null : null
  const name = typeof stored.event === 'string' ? stored.event : event?.type ?? null
  return { ...stored, event: name, to: event?.to ?? stored.to ?? null, ...(event?.feedback && { feedback: event.feedback }) }
}

export async function toAuditEntries(db: Executor, rows: (typeof auditLog.$inferSelect)[]): Promise<AuditEntry[]> {
  const nameOf = await actorNames(db, rows.map(r => r.actor))
  return rows.map(row => ({ id: row.id, projectId: row.projectId, taskId: row.taskId, actor: row.actor, agentName: nameOf(row.actor), action: row.action, detail: row.detail as Record<string, unknown>, createdAt: row.createdAt.toISOString() }))
}

// PRD §14: every claim, transition, review and merge decision, readable per task
export async function listHistory(db: Executor, taskId: string): Promise<AuditEntry[]> {
  const rows = await db.select().from(auditLog).where(eq(auditLog.taskId, taskId)).orderBy(asc(auditLog.createdAt), asc(auditLog.id))
  return toAuditEntries(db, rows)
}
