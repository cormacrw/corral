import type { TaskStatus } from './status.ts'

// Task fields other than status (PRD §4.3, design/task.md)
export const TASK_PRIORITIES = ['urgent', 'high', 'medium', 'low'] as const
export type TaskPriority = typeof TASK_PRIORITIES[number]

// D19: task = normal PR work, bug = a fix for wrong behaviour, spike = an
// investigation whose deliverable is written findings. D20: design = a UI or
// flow agreed as an approved prototype before it's built.
export const TASK_TYPES = ['task', 'bug', 'spike', 'design'] as const
export type TaskType = typeof TASK_TYPES[number]

// D19/D20: spikes and designs always go to Human review, whatever their flag says
export function requiresHumanReview(type: TaskType, humanReview: boolean): boolean {
  return type === 'spike' || type === 'design' || humanReview
}

// The deliverable type is fixed once work is approved or awaiting merge. Spikes
// and designs have their own flow to the end (D19, D20), so a task can't enter
// or leave those types once it has left Draft or Backlog: a retyped design
// could otherwise be approved into Ready to merge.
export function canChangeType(task: { status: TaskStatus, type: TaskType }, to: TaskType): boolean {
  if (to === task.type) return true
  if (['approved', 'ready_to_merge', 'merged'].includes(task.status)) return false
  if (task.status === 'draft' || task.status === 'backlog') return true
  return ![task.type, to].some(type => type === 'spike' || type === 'design')
}

// Task IDs are PREFIX-NUMBER, e.g. COR-29 (D13)
export function taskRef(prefix: string, number: number): string {
  return `${prefix}-${number}`
}
