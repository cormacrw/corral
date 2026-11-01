// Task fields other than status (PRD §4.3, design/task.md)
export const TASK_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const
export type TaskPriority = typeof TASK_PRIORITIES[number]

// D19: task = normal PR work, bug = a fix for wrong behaviour, spike = an
// investigation whose deliverable is written findings. D20: design = a UI or
// flow agreed as an approved prototype before it's built.
export const TASK_TYPES = ['task', 'bug', 'spike', 'design'] as const
export type TaskType = typeof TASK_TYPES[number]

// Why the task was created, separate from its work type.
export const TASK_KINDS = ['normal', 'fix', 'conflict'] as const
export type TaskKind = typeof TASK_KINDS[number]

// D19/D20: spikes and designs always go to Human review, whatever their flag says
export function requiresHumanReview(type: TaskType, humanReview: boolean): boolean {
  return type === 'spike' || type === 'design' || humanReview
}

// Task IDs are PREFIX-NUMBER, e.g. COR-29 (D13)
export function taskRef(prefix: string, number: number): string {
  return `${prefix}-${number}`
}
