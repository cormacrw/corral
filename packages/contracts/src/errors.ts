import type { TransitionError } from '@corral/core'

// ── Errors ──────────────────────────────────────────────────────────────────

export type ApiError =
  | { code: 'not_found' }
  // A human-only action attempted by anyone else
  | { code: 'forbidden' }
  | { code: 'invalid_input', issues: unknown }
  | { code: 'conflict', constraint: string | null }
  | { code: 'transition_rejected', reason: TransitionError }
  | { code: 'invalid_dependencies', problems: unknown }
  // A task the plan revises can no longer take its edits; each message names one
  | { code: 'plan_not_approvable', problems: { code: string, key: string, ref: string, message: string }[] }
  | { code: 'runner_offline' }
  | { code: 'corral_updating' }
  // PM turns have no concurrency, only one per Plan session (D9, D13)
  | { code: 'concurrency_not_applicable' }
  // A message for a run that can't take one, with a reason a person can read
  | { code: 'run_not_live', reason: string }
  // The task hasn't opened a PR
  | { code: 'no_pull_request' }
  // GitHub didn't return the PR; `message` says why in its words
  | { code: 'pull_request_unavailable', number: number, message: string }

export interface ApiErrorBody {
  error: ApiError
}
