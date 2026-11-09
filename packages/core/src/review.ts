// What a reviewer decides about a round (flows.md step 6)
export const REVIEW_VERDICTS = ['approved', 'changes_requested'] as const
export type ReviewVerdict = typeof REVIEW_VERDICTS[number]

// What a developer attaches to prove a criterion. A `note` is written
// evidence with no file (D21).
export const EVIDENCE_KINDS = ['screenshot', 'video', 'test_output', 'log', 'request', 'text', 'other', 'note'] as const
export type EvidenceKind = typeof EVIDENCE_KINDS[number]

// The reviewer's judgment of an epic rebase's conflict resolution, bound to the
// commit it read. Only `preserved` on the published commit can carry approval.
export interface ResolutionReview {
  runId: string
  headSha: string
  preserved: boolean
  summary: string
  // Set just before publishing, while the old head can still be compared
  outsideConflicts?: string[]
  checkError?: string | null
}

// What a developer run on an epic is fixing, with no task (D29)
export const EPIC_FIX_KINDS = ['conflict', 'ci', 'review'] as const
export type EpicFixKind = typeof EPIC_FIX_KINDS[number]

// A required check, as GitHub named it
export interface GateCheck {
  name: string
  url: string | null
}

// A reviewer's verdict on one acceptance criterion; null met is a human check
export interface CriterionVerdict {
  criterionId: string
  met: boolean | null
  note: string
}

// An integration review's finding, with the task refs it concerns (D23)
export const FINDING_LEVELS = ['blocking', 'non_blocking'] as const
type FindingLevel = typeof FINDING_LEVELS[number]
export interface EpicReviewFinding {
  level: FindingLevel
  text: string
  taskRefs: string[]
}

// What the developer reported for a candidate, bound to that commit. Only the
// server's compare, stored here before publishing, lets a conflict fix keep
// approval.
export interface EpicFixReport {
  runId: string
  headSha: string
  behaviourChanged: boolean
  conflictedFiles: string[]
  summary: string
  outsideConflicts?: string[]
  checkError?: string | null
  // What it changes in files only the target changed, for the integration review
  targetFiles?: TargetFileChange[]
}

export interface TargetFileChange {
  path: string
  diff: string
  truncated: boolean
}

// A choice of product behaviour that a resolution can't make for itself
interface EpicDecisionAlternative {
  label: string
  effect: string
  // Taking this option changes what was approved, so review starts over
  changesBehaviour: boolean
}

export interface EpicDecisionRequest {
  question: string
  bindingDecision?: string | undefined
  alternatives: EpicDecisionAlternative[]
  affectedChanges: string[]
}

export interface EpicDecisionAnswer {
  alternative: number | null
  label: string
  text: string | null
  // A free-form answer counts as a change: nothing shows that it isn't
  changesBehaviour: boolean
  at: string
}

export interface EpicRebaseDecision extends EpicDecisionRequest {
  id: string
  runId: string
  raisedAt: string
  answer: EpicDecisionAnswer | null
}
