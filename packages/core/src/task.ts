// Task fields other than status (PRD §4.3, design/task.md)
export const TASK_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const
export type TaskPriority = typeof TASK_PRIORITIES[number]

export const TASK_TYPES = ['frontend', 'backend', 'full_stack', 'infrastructure'] as const
export type TaskType = typeof TASK_TYPES[number]

// Task IDs are PREFIX-NUMBER, e.g. COR-29 (D13)
export function taskRef(prefix: string, number: number): string {
  return `${prefix}-${number}`
}
