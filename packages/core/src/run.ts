import { REVIEW_VERDICTS } from './review.ts'

export const REBASE_REVIEWS = ['trivial', 'needs_review'] as const
export type RebaseReview = typeof REBASE_REVIEWS[number]

// Agent runs (PRD §4.5, §8.6). A run is one agent session; a task can have many.
export const RUN_STATES = [
  'queued',
  'starting',
  'running',
  'waiting_for_input',
  'stopping',
  'completed',
  'failed',
  'interrupted'
] as const
export type RunState = typeof RUN_STATES[number]

// Runs in these states count against their agent's concurrency
export const ACTIVE_RUN_STATES = ['queued', 'starting', 'running', 'waiting_for_input', 'stopping'] as const satisfies readonly RunState[]

// A run in one of these states has ended, and only then has an end time
export const TERMINAL_RUN_STATES = ['completed', 'failed', 'interrupted'] as const satisfies readonly RunState[]
export type ActiveRunState = typeof ACTIVE_RUN_STATES[number]
export type TerminalRunState = typeof TERMINAL_RUN_STATES[number]

// How a run ended, as reported by the agent and validated by the server.
// `rate_limited` is not a failure (D3).
export const RUN_OUTCOMES = [
  'pr_opened',
  'pr_updated',
  'pr_rebased',
  // An epic task's developer: a commit on its own branch, with no task PR (D27)
  'commit_submitted',
  // A spike's developer: findings instead of a PR (D19)
  'findings_reported',
  // A design task's designer: a new design version instead of a PR (D20)
  'design_submitted',
  ...REVIEW_VERDICTS,
  'blocked',
  'stuck',
  'failed',
  'rate_limited'
] as const
export type RunOutcome = typeof RUN_OUTCOMES[number]

// Any role's run can fail or hit a usage limit. The database enforces this
// split too (runs_outcome_matches_role).
const ANY_ROLE_RUN_OUTCOMES = ['failed', 'rate_limited'] as const satisfies readonly RunOutcome[]
// design_submitted stays on developers for runs from before the designer role
export const DEVELOPER_RUN_OUTCOMES = ['pr_opened', 'pr_updated', 'pr_rebased', 'commit_submitted', 'findings_reported', 'design_submitted', 'stuck', ...ANY_ROLE_RUN_OUTCOMES] as const satisfies readonly RunOutcome[]
export const DESIGNER_RUN_OUTCOMES = ['design_submitted', 'stuck', ...ANY_ROLE_RUN_OUTCOMES] as const satisfies readonly RunOutcome[]
export const REVIEWER_RUN_OUTCOMES = [...REVIEW_VERDICTS, 'blocked', ...ANY_ROLE_RUN_OUTCOMES] as const satisfies readonly RunOutcome[]
export const PM_RUN_OUTCOMES = ANY_ROLE_RUN_OUTCOMES
export type DeveloperRunOutcome = typeof DEVELOPER_RUN_OUTCOMES[number]
export type DesignerRunOutcome = typeof DESIGNER_RUN_OUTCOMES[number]
export type ReviewerRunOutcome = typeof REVIEWER_RUN_OUTCOMES[number]
export type PmRunOutcome = typeof PM_RUN_OUTCOMES[number]
