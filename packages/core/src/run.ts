import type { AgentRole } from './actor.ts'
import type { TaskType } from './task.ts'
import { REVIEW_VERDICTS } from './review.ts'

export const REBASE_REVIEWS = ['trivial', 'needs_review'] as const
export type RebaseReview = typeof REBASE_REVIEWS[number]

// Agent runs (PRD §4.5, §8.6). A run is one agent session; a task can have many.
export const RUN_STATES = [
  'queued',
  'running',
  'completed',
  'failed',
  'interrupted'
] as const
export type RunState = typeof RUN_STATES[number]

// Runs in these states count against their agent's concurrency
export const ACTIVE_RUN_STATES = ['queued', 'running'] as const satisfies readonly RunState[]

export function isActiveRun(state: RunState): boolean {
  return (ACTIVE_RUN_STATES as readonly RunState[]).includes(state)
}

// A run in one of these states has ended, and only then has an end time
export const TERMINAL_RUN_STATES = ['completed', 'failed', 'interrupted'] as const satisfies readonly RunState[]

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

// The outcomes that carry the author's commit, which the runner pushes before
// it reports them
export const COMMIT_OUTCOMES = ['pr_opened', 'pr_updated', 'pr_rebased', 'commit_submitted', 'design_submitted'] as const satisfies readonly RunOutcome[]

export function isCommitOutcome(outcome: string): outcome is typeof COMMIT_OUTCOMES[number] {
  return (COMMIT_OUTCOMES as readonly string[]).includes(outcome)
}

// Roles that write to a task's branch
export const AUTHORING_ROLES = ['developer', 'designer'] as const satisfies readonly AgentRole[]
type AuthoringRole = typeof AUTHORING_ROLES[number]

export function isAuthoringRole(role: AgentRole): role is AuthoringRole {
  return (AUTHORING_ROLES as readonly AgentRole[]).includes(role)
}

// A design task's author is the designer (D20); every other type's is the developer
export function authorRoleFor(type: TaskType): AuthoringRole {
  return type === 'design' ? 'designer' : 'developer'
}

// Roles that can run on an epic with no task: its integration review and its
// fix rounds (D27, D29)
export const EPIC_RUN_ROLES = ['reviewer', 'developer'] as const satisfies readonly AgentRole[]

// Roles whose live runs take a human's messages; the PM talks in its Plan thread
export const ROLES_TAKING_MESSAGES = ['developer', 'designer', 'reviewer'] as const satisfies readonly AgentRole[]

export function roleTakesMessages(role: AgentRole): boolean {
  return (ROLES_TAKING_MESSAGES as readonly AgentRole[]).includes(role)
}

// How an author run's session began: a warm resume still has the prompt cache
export type RunSessionStart = 'fresh' | 'resumed_warm' | 'resumed_cold'

// Where a run's time went. An `agent_*` phase is one agent process or turn,
// less any phase nested in it: a push or design pack inside a tool call
// pauses the agent's clock. `other` is everything unnamed.
export const RUN_PHASES = [
  'worktree_prepare', 'session_setup', 'design_save', 'agent_cold_start',
  'agent_resume', 'agent_warm_turn', 'design_pack', 'push', 'finish', 'other'
] as const
export type RunPhase = typeof RUN_PHASES[number]

// Measured by the runner from assignment to run.ended, so totalMs starts
// before the run's startedAt and can end after its endedAt.
export interface RunTimings {
  totalMs: number
  // In the order the run first entered them; they add up to totalMs
  phases: { phase: RunPhase, durationMs: number }[]
  tools: { tool: string, count: number, totalMs: number, maxMs: number }[]
}

// What a run was dispatched against, to tell a repeated failure from one
// whose inputs changed
export interface RetryContext {
  head: string
  target: string
  human: string
}
