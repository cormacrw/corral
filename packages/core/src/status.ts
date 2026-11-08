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
  'failed',
  // A task with sub-tasks. It has no run or transitions of its own: its stage
  // is computed from its sub-tasks and delivery state (D31)
  'parent'
] as const

export type TaskStatus = typeof TASK_STATUSES[number]

// The scheduler only starts runs for tasks in these statuses (D10)
export const RUNNABLE_STATUSES = ['ready', 'in_progress', 'agent_review'] as const satisfies readonly TaskStatus[]

// Blocked and failed tasks always say why; no other status keeps a reason
export const REASON_STATUSES = ['blocked', 'failed'] as const satisfies readonly TaskStatus[]
export type ReasonStatus = typeof REASON_STATUSES[number]

export function needsStatusReason(status: TaskStatus): status is ReasonStatus {
  return (REASON_STATUSES as readonly TaskStatus[]).includes(status)
}

// Draft and Backlog are off the board: they don't count towards a task's
// subtasks or its delivery (D10, D31)
export const PRE_BOARD_STATUSES = ['draft', 'backlog'] as const satisfies readonly TaskStatus[]

export function isOnBoard(status: TaskStatus): boolean {
  return !(PRE_BOARD_STATUSES as readonly TaskStatus[]).includes(status)
}

// No work has started: a plan may still revise it, and a design pin can go stale (D20)
export const NOT_STARTED_STATUSES = ['draft', 'backlog', 'ready'] as const satisfies readonly TaskStatus[]

export function isNotStarted(status: TaskStatus): boolean {
  return (NOT_STARTED_STATUSES as readonly TaskStatus[]).includes(status)
}

// A status's name, as the app shows it and the PM reads it. Approved designs
// and merged tasks are both Complete.
export const TASK_STATUS_LABELS: Record<TaskStatus, string> = {
  draft: 'Draft',
  backlog: 'Backlog',
  ready: 'Ready',
  in_progress: 'In progress',
  agent_review: 'Agent review',
  human_review: 'Human review',
  ready_to_merge: 'Ready to merge',
  approved: 'Complete',
  merged: 'Complete',
  blocked: 'Blocked',
  failed: 'Failed',
  parent: 'With subtasks'
}

// A status in words, e.g. "human review"
export function statusWords(status: string): string {
  return status.replaceAll('_', ' ')
}
