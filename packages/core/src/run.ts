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

// How a run ended, as reported by the agent and validated by the server.
// `rate_limited` is not a failure (D3).
export const RUN_OUTCOMES = [
  'pr_opened',
  'pr_updated',
  // A spike's developer: findings instead of a PR (D19)
  'findings_reported',
  // A design task's developer: a new design version instead of a PR (D20)
  'design_submitted',
  'approved',
  'changes_requested',
  'stuck',
  'failed',
  'rate_limited'
] as const
export type RunOutcome = typeof RUN_OUTCOMES[number]
