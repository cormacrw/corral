// Task statuses (D10). A status says whose turn it is; whether a run is
// active is shown by the lease, not the status.
export const TASK_STATUSES = [
  'draft',
  'backlog',
  'ready',
  'in_progress',
  'agent_review',
  'human_review',
  'ready_to_merge',
  'merged',
  'approved',
  'blocked',
  'failed'
] as const

export type TaskStatus = typeof TASK_STATUSES[number]

// The scheduler only starts runs for tasks in these statuses (D10)
export const RUNNABLE_STATUSES = ['ready', 'in_progress', 'agent_review'] as const satisfies readonly TaskStatus[]
