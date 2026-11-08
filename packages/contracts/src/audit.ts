import type { Actor, EpicFixKind, RebaseReview, ReviewVerdict, TaskStatus } from '@corral/core'
import type { SetupJobResult } from './runner.ts'
import type { HumanTransitionInput } from './tasks.ts'

// What the audit log stores (D1): each action and the detail it carries. The
// server writes these; the web app labels them.

// Which of D24's two conditions the server check found broken, and where
export interface RebaseCheckFailure {
  condition: 'changes_outside_conflicts' | 'project_docs_changed'
  files: string[]
}

// What applyTransition is told about a status change. Human transitions keep
// the whole input as `event`; every other producer writes the event's name.
export type TransitionDetail =
  | { event: HumanTransitionInput }
  | { event: 'pr_opened' | 'pr_updated' | 'pr_rebased' | 'commit_submitted', runId: string, headSha: string | undefined, pr: number | null, checkFailures?: RebaseCheckFailure[], checkError?: string }
  | { event: 'findings_reported', runId: string, headSha: string }
  | { event: 'design_submitted', runId: string, headSha: string | undefined, version: number }
  | { event: 'review_approved', runId?: string, headSha: string | null }
  | { event: 'approval_carried', runId?: string, headSha: string | null }
  | { event: 'changes_requested', runId: string, headSha: string, similarity?: number }
  | { event: 'human_approve', headSha: string | null }
  | { event: 'head_moved', headSha: string }
  | { event: 'merged', pr: number, mergeCommitSha: string | null, outside?: true }
  // An epic rebase task with nothing left to merge
  | { event: 'merged', headSha: string | null }
  // A PR-free task, confirmed on the epic branch (D27)
  | { event: 'integrated', submissionId: string, integratedCommitSha: string }
  | { event: 'require_human_check' | 'answer' }
  | { event: 'ci_failed', checks: string[] }
  | { event: 'base_conflict', mergeableState?: string | null }
  | { event: 'pr_closed' | 'merge_failed' | 'merged_after_veto' }
  | { event: 'run_failed', runId: string, error: string }
  | { event: 'blocked' | 'stuck', runId: string }
  | { event: 'dependency_deleted', dependency: string }
  | { event: 'release_stop' }

// The event name a transition's entry is read back by: a human transition's
// input type, or the name other producers wrote
export type TransitionEventName = Exclude<TransitionDetail['event'], HumanTransitionInput> | HumanTransitionInput['type']

// Why an epic's approval did or didn't survive a rebase, with every commit
// involved: the epic's history has to answer that on its own (COR-291)
export interface ApprovalChange {
  event: 'approval_retained' | 'approval_invalidated'
  approvedHeadSha: string | null
  from: string
  to: string
  ontoSha: string | null
  operationId: string | null
  resolutionTaskId: string | null
  resolutionReview: { runId: string, preserved: boolean, summary: string } | null
  reason: string
  summary: string
}

// The epic PR events that go with a review state change
export type EpicPrDetail =
  | { event: 'opened' | 'review_started', prNumber: number }
  | { event: 'approved' | 'changes_requested' | 'human_approved' | 'human_changes_requested' | 'review_failed', headSha: string | null, summary: string, confirmedCriteria?: string[], confirmedTasks?: string[], fixTasks?: { id: string, ref: string, title: string }[] }
  | { event: 'closed' }
  | { event: 'rebased', from: string | null, to: string }
  | { event: 'conflict', summary: string, files: string[] }
  | { event: 'merge_refused', summary: string }
  | { event: 'rebase_resolving', summary: string, files: string[] }
  | { event: 'rebase_failed', summary: string }
  | { event: 'conflict_deferred', summary: string, files: string[] }
  // `fix` names the CI or review fix this stopped, when it wasn't a rebase
  | { event: 'sync_failed', summary: string, fix?: EpicFixKind }
  | { event: 'sync_retried', fix?: EpicFixKind }
  | { event: 'fix_started', fix: EpicFixKind, operationId: string, summary: string, files?: string[] }
  | { event: 'fix_reported', fix: EpicFixKind, operationId: string, runId: string, headSha: string, behaviourChanged: boolean, files: string[], summary: string }
  | { event: 'fix_refused', fix: EpicFixKind, operationId: string, summary: string }
  | { event: 'fix_published', fix: EpicFixKind, operationId: string, from: string, to: string }
  | ApprovalChange
  | { event: 'decision_requested', operationId: string, decisionId: string, summary: string, bindingDecision: string | null, alternatives: string[], affectedChanges: string[] }
  | { event: 'decision_answered', operationId: string, decisionId: string, summary: string, changesBehaviour: boolean }

type StatusChange = { from: TaskStatus, to: TaskStatus }
type Changed = { changed: string[] }
type RunComment = { runId: string, runNumber: number, commentId: string }
type AgentChange = Changed & { agentId: string }
type PmActionDetail = { actionId: string, sessionId: string, runId: string | null, targetId?: string | null, proposer?: Actor, tool?: string, input?: unknown, summary?: string, result?: unknown, error?: string | null }
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
  'integration.operation': { operationId: string, submissionId: string, event: 'started' | 'succeeded' | 'failed' | 'checks_deferred', expectedTargetSha: string, leaseEpoch: number, commitSha?: string, error?: string }
  'merge.gates_failed': { pr: number, headSha: string, gates: string[] }
  'merge.refused': { pr: number, message: string, attempt: number, epicId?: string }
  'plan.approved': { planId: string, version: number, to: string, viaPmRun?: string }
  'plan.discarded': { planId: string, version: number, deleted: number }
  'plan.message': PlanMessage
  'plan.proposed': { planId: string, version: number, tasks: number, revises: number }
  'plan.runtime': { sessionId: string, from: string, to: string }
  'pm.action_proposed': PmActionDetail
  'pm.action_cancelled': PmActionDetail
  'pm.action_confirmed': PmActionDetail
  'pm.action_failed': PmActionDetail
  'pm.tool_called': { targetId?: string | null, sessionId: string, runId: string, tool: string, input: unknown, ok: boolean, summary: string, error?: string }
  'project.created': Record<string, never>
  'project.deleted': { projectId: string, name: string, repository: string }
  'project.paused': Changed
  'project.resumed': Changed
  'project.updated': Changed
  'rebase.verified': { runId: string, pr: number | null, approvedHeadSha: string | null, headSha: string | undefined, conflictedFiles: string[] | undefined }
  'review.recorded': { runId: string, verdict: ReviewVerdict, headSha: string, round: number, met: number, of: number, similarity?: number, carriedFrom?: string | null }
  'run.ended': { runId: string, runNumber: number, state: string, outcome: string | null, error: string | null, behaviourChanged?: boolean | undefined, review?: RebaseReview | undefined, conflictedFiles?: string[] | undefined }
  'run.message_sent': RunComment & { attachments: string[] }
  'run.stopped': { runId: string }
  'task.claimed': StatusChange & { runId: string, agentId: string, leaseEpoch: number }
  'task.created': { number: number }
  'task.promoted': { firstSub: string, from: string }
  'task.deleted': { mode: string, number: number, title: string, reason: string | null }
  'task.edit_pinned': RunComment
  'task.paused': Record<string, never>
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
