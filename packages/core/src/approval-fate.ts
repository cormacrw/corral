import type { EpicReviewState } from './project.ts'
import { shortSha } from './ids.ts'
import type { EpicFixKind, EpicFixReport, EpicRebaseDecision, ResolutionReview } from './review.ts'

// The states in which a task's PR head carries an approval worth keeping.
// Legacy `conflict` rows got there from one of the other two.
export const APPROVED_STATES: readonly (EpicReviewState | null)[] = ['human_review', 'ready_to_merge', 'conflict']

export interface ApprovalFate {
  kept: boolean
  reason: string
}

// A journaled rebase or fix of the task's branch, as approval reads it (D27, D29)
export interface BranchOperation {
  expectedTargetSha: string
  fix: EpicFixKind | null
  fixReport: EpicFixReport | null
  resolutionTaskId: string | null
  resolutionReview: ResolutionReview | null
  decisions: readonly EpicRebaseDecision[]
}

export interface ApprovedDelivery {
  reviewState: EpicReviewState | null
  approvedHeadSha: string | null
  prHeadSha: string | null
}

// What the human said on the operation, where it decides
function decisionFate(operation: BranchOperation): ApprovalFate | null {
  const unanswered = operation.decisions.find(d => !d.answer)
  if (unanswered) return { kept: false, reason: `The question "${unanswered.question}" was closed without an answer.` }
  const changed = operation.decisions.find(d => d.answer?.changesBehaviour)
  if (changed) return { kept: false, reason: `The human's decision changes approved behaviour: ${changed.answer!.label}.` }
  return null
}

// The server's own compare of the approved and rebased changes. Fails closed:
// no compare on record is no validation.
function compareFate(check: { checkError?: string | null, outsideConflicts?: string[] }, commitSha: string): ApprovalFate | null {
  if (check.checkError) return { kept: false, reason: `The server could not compare the approved and rebased changes: ${check.checkError}` }
  if (!check.outsideConflicts) return { kept: false, reason: `The server never compared the approved and rebased changes of ${shortSha(commitSha)}.` }
  if (check.outsideConflicts.length) return { kept: false, reason: `The resolution changed files outside the conflicts: ${check.outsideConflicts.join(', ')}.` }
  return null
}

// What publishing a developer's fix means for approval (D29). Only the
// developer's report on exactly this commit can keep it, and for a conflict
// only with the server's compare agreeing.
function fixFate(operation: BranchOperation, commitSha: string): ApprovalFate {
  const report = operation.fixReport
  if (report?.headSha !== commitSha) return { kept: false, reason: `No developer report covers ${shortSha(commitSha)}.` }
  const decided = decisionFate(operation)
  if (decided) return decided
  if (report.behaviourChanged) return { kept: false, reason: `The developer reported a behaviour change: ${report.summary}` }
  if (operation.fix === 'review') return { kept: false, reason: 'Integration review changes are always reviewed again.' }
  if (operation.fix === 'ci') return { kept: true, reason: `The developer reported no behaviour change; CI runs again on the new head: ${report.summary}` }
  return compareFate(report, commitSha) ?? { kept: true, reason: `The developer reported no behaviour change and the server found differences only in the conflicted files: ${report.summary}` }
}

// Whether approval survives a rebase being published as `commitSha`, or null
// when there's no approval to speak of. Every path to `kept` starts from the
// journaled operation having begun on the exact approved head, so a commit that
// reached the branch any other way can't inherit anything (COR-291).
export function approvalFate(operation: BranchOperation, delivery: ApprovedDelivery, commitSha: string): ApprovalFate | null {
  if (!APPROVED_STATES.includes(delivery.reviewState) || commitSha === operation.expectedTargetSha) return null
  if (!delivery.approvedHeadSha || delivery.prHeadSha !== operation.expectedTargetSha) {
    return { kept: false, reason: `The rebase started from ${shortSha(operation.expectedTargetSha)}, which isn't the approved head ${shortSha(delivery.prHeadSha)}.` }
  }
  if (operation.fix) return fixFate(operation, commitSha)
  if (!operation.resolutionTaskId) return { kept: true, reason: 'A clean rebase changes nothing that was approved; checks run again on the new head.' }
  const review = operation.resolutionReview
  if (review?.headSha !== commitSha) return { kept: false, reason: `No review of the resolution covers ${shortSha(commitSha)}.` }
  const decided = decisionFate(operation)
  if (decided) return decided
  if (!review.preserved) return { kept: false, reason: `The reviewer found a behaviour change: ${review.summary}` }
  return compareFate(review, commitSha) ?? { kept: true, reason: `The reviewer confirmed the resolution keeps the approved behaviour: ${review.summary}` }
}
