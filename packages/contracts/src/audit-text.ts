import type { AuditDetails } from './audit.ts'

// How epic PR audit events read, for the server's Inbox and epic history and
// for the web's Activity tab. Schema-free, so the web takes it from /client.

export type EpicPrEvent = AuditDetails['epic.pr']['event']

// A sentence of its own: the Inbox and the epic's history
const EPIC_PR_EVENT_LABELS: Record<EpicPrEvent, string> = {
  opened: 'The task\'s PR opened',
  review_started: 'Task integration review started',
  approved: 'The task\'s PR approved by reviewer',
  changes_requested: 'Task integration changes requested',
  human_approved: 'You approved the task\'s PR',
  human_changes_requested: 'You requested changes on the task\'s PR',
  rebase_requested: 'Rebasing the task\'s PR onto the target branch',
  rebased: 'The task\'s PR rebased; CI runs again',
  conflict: 'The task\'s PR conflict',
  rebase_handed_off: 'You handed the task\'s PR rebase to a developer',
  rebase_resolving: 'Task rebase conflict sent to a developer',
  rebase_failed: 'Task rebase attempt failed',
  conflict_deferred: 'Rebase conflict left until the task is about to land',
  sync_failed: 'Task rebase stopped',
  sync_retried: 'You retried the task rebase',
  ci_failed: 'CI failed on the task\'s PR',
  merge_refused: 'GitHub refused the task\'s PR merge',
  review_failed: 'Task integration review stopped retrying',
  closed: 'The task\'s PR closed on GitHub',
  merged: 'The task\'s PR merged',
  approval_retained: 'Approval kept across the rebase',
  approval_invalidated: 'Approval no longer applies; review starts again',
  decision_requested: 'A task rebase needs your decision',
  decision_answered: 'You decided on the task rebase',
  fix_started: 'A developer was asked to fix the task',
  fix_reported: 'The developer reported a task fix',
  fix_refused: 'Corral refused the task fix and sent it back',
  fix_published: 'The task fix reached the task\'s branch; CI runs again'
}

// A CI or review fix stops and retries through the same events as a rebase
const EPIC_FIX_EVENT_LABELS: Partial<Record<EpicPrEvent, string>> = { sync_failed: 'Task fix stopped', sync_retried: 'You retried the task fix' }

export function epicPrEventLabel(event: string | null, fix: string | null | undefined): string | null {
  const known = event as EpicPrEvent
  return ((fix === 'ci' || fix === 'review') && EPIC_FIX_EVENT_LABELS[known]) || EPIC_PR_EVENT_LABELS[known] || event
}

// Worded to follow the actor's name in the Activity tab
export const EPIC_PR_ACTIVITY: Partial<Record<EpicPrEvent, string>> = {
  opened: 'opened the task\'s PR',
  review_started: 'started the task\'s integration review',
  approved: 'approved the task\'s PR',
  changes_requested: 'requested changes on the task\'s PR',
  human_approved: 'approved the task\'s PR',
  human_changes_requested: 'requested changes on the task\'s PR',
  rebase_requested: 'asked to rebase the task\'s PR onto the target branch',
  rebased: 'rebased the task\'s PR; CI runs again',
  conflict: 'found a conflict on the task\'s PR',
  rebase_handed_off: 'handed the task\'s PR rebase to a developer',
  ci_failed: 'saw CI fail on the task\'s PR',
  merge_refused: 'stopped retrying after GitHub refused the task\'s PR merge',
  closed: 'saw the task\'s PR closed on GitHub',
  merged: 'merged the task\'s PR'
}
