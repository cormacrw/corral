// Task fields other than status (PRD §4.3, design/task.md)
export const TASK_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const
export type TaskPriority = typeof TASK_PRIORITIES[number]

// D19: task = normal PR work, bug = a fix for wrong behaviour, spike = an
// investigation whose deliverable is written findings
export const TASK_TYPES = ['task', 'bug', 'spike'] as const
export type TaskType = typeof TASK_TYPES[number]

// Task IDs are PREFIX-NUMBER, e.g. COR-29 (D13)
export function taskRef(prefix: string, number: number): string {
  return `${prefix}-${number}`
}
