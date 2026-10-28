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

// How a run ended, as reported by the agent and validated by the server.
// `rate_limited` is not a failure (D3).
export const RUN_OUTCOMES = [
  'pr_opened',
  'pr_updated',
  'approved',
  'changes_requested',
  'stuck',
  'failed',
  'rate_limited'
] as const
export type RunOutcome = typeof RUN_OUTCOMES[number]
