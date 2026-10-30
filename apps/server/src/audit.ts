import type { HumanTransitionInput, SetupJobResult } from '@corral/contracts'
import type { Actor, ReviewVerdict, TaskStatus } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { sql, type SQL } from 'drizzle-orm'

const { auditLog } = schema

// What applyTransition is told about a status change. Human transitions keep
// the whole input as `event`; every other producer writes the event's name.
export type TransitionDetail =
  | { event: HumanTransitionInput }
  | { event: 'pr_opened' | 'pr_updated' | 'pr_rebased', runId: string, headSha: string | undefined, pr: number | null }
  | { event: 'findings_reported', runId: string, headSha: string }
  | { event: 'design_submitted', runId: string, headSha: string | undefined, version: number }
  | { event: 'review_approved', runId?: string, headSha: string | null }
  | { event: 'changes_requested', runId: string, headSha: string, similarity?: number }
  | { event: 'human_approve', headSha: string | null }
  | { event: 'head_moved', headSha: string }
  | { event: 'merged', pr: number, mergeCommitSha: string | null, outside?: true }
  // An epic rebase task with nothing left to merge
  | { event: 'merged', headSha: string | null }
  | { event: 'require_human_check' }
  | { event: 'ci_failed', checks: string[] }
  | { event: 'base_conflict', mergeableState?: string | null }
  | { event: 'pr_closed' | 'merge_failed' }
  | { event: 'run_failed', runId: string, error: string }
  | { event: 'blocked' | 'stuck', runId: string }
  | { event: 'dependency_deleted', dependency: string }

// The epic PR events that go with a review state change
export type EpicPrDetail =
  | { event: 'opened' | 'review_started', prNumber: number }
  | { event: 'approved' | 'changes_requested' | 'human_approved' | 'human_changes_requested', headSha: string | null, summary: string }
  | { event: 'closed' }
  | { event: 'rebased', from: string | null, to: string }
  | { event: 'conflict', summary: string, files: string[] }
  | { event: 'merge_refused', summary: string }

type StatusChange = { from: TaskStatus, to: TaskStatus }
type Changed = { changed: string[] }
type RunComment = { runId: string, runNumber: number, commentId: string }
type AgentChange = Changed & { agentId: string }
type PlanMessage = { sessionId: string, messageId: string }

// The detail each action stores. A new action or key starts here.
export interface AuditDetails {
  'agent.created': { agentId: string, role: string, runtime: string }
  'agent.paused': AgentChange
  'agent.resumed': AgentChange
  'agent.updated': AgentChange
  'branch.head_moved': { from: string | null, to: string, approvalKept: boolean }
  'branch.update_requested': { pr: number, headSha: string }
  'corral.resumed': Record<string, never>
  'corral.stopped': Record<string, never>
  'design.approved': { version: number }
  'design.submitted': { runId: string, version: number, headSha: string, screenshots: number }
  'epic.pr': { epicId: string } & (EpicPrDetail | { event: 'rebase_requested' | 'rebase_handed_off', headSha: string | null } | { event: 'ci_failed', summary: string } | { event: 'merged', pr: number, mergeCommitSha: string | null })
  'epic.updated': Changed & { epicId: string, dependsOn?: string[] }
  'merge.refused': { pr: number, message: string, attempt: number, epicId?: string }
  'plan.approved': { planId: string, version: number, to: string, viaPmRun?: string }
  'plan.discarded': { planId: string, version: number, deleted: number }
  'plan.message': PlanMessage
  'plan.proposed': { planId: string, version: number, tasks: number, revises: number }
  'plan.runtime': { sessionId: string, from: string, to: string }
  'pm.tool_called': { sessionId: string, runId: string, tool: string, input: unknown, ok: boolean, summary: string, error?: string }
  'project.created': Record<string, never>
  'project.deleted': { projectId: string, name: string, repository: string }
  'project.paused': Changed
  'project.resumed': Changed
  'project.updated': Changed
  'review.recorded': { runId: string, verdict: ReviewVerdict, headSha: string, round: number, met: number, of: number, similarity?: number }
  'run.ended': { runId: string, runNumber: number, state: string, outcome: string | null, error: string | null }
  'run.message_sent': RunComment & { attachments: string[] }
  'run.stopped': { runId: string }
  'task.claimed': StatusChange & { runId: string, agentId: string, leaseEpoch: number }
  'task.created': { number: number }
  'task.deleted': { mode: string, number: number, title: string, reason: string | null }
  'task.edit_pinned': RunComment
  'task.resumed': Record<string, never>
  'task.revised': { planId: string, version: number, fields: string[] }
  'task.transition': TransitionDetail & StatusChange
  'task.updated': Changed
  'worktrees.cleaned': Extract<SetupJobResult, { kind: 'cleanup_worktrees' }>
  'worktrees.swept': { removed: string[], kept: string[] }
}

export type AuditAction = keyof AuditDetails

// One entry's action and its detail, linked by type
export type AuditEvent = { [A in AuditAction]: { action: A, detail: AuditDetails[A] } }[AuditAction]

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
  to: string | null
  verdict?: string
  met?: number
  of?: number
  version?: number
  summary?: string
}

// Reads a stored detail, whatever its age. `event` was written as a name by
// most producers and as the human's whole input by others, sometimes with
// the target status only inside it. Rows are never rewritten, so both stay.
export function readAudit(detail: unknown): AuditView {
  const stored = (detail ?? {}) as Omit<AuditView, 'event' | 'to'> & { event?: unknown, to?: string }
  const event = typeof stored.event === 'object' ? stored.event as { type?: string, to?: string } | null : null
  const name = typeof stored.event === 'string' ? stored.event : event?.type ?? null
  return { ...stored, event: name, to: event?.to ?? stored.to ?? null }
}
