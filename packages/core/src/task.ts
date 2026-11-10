import type { TaskStatus } from './status.ts'

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

// Types whose work is code, delivered through a PR or a submitted commit.
// Spikes deliver findings and designs a prototype (D19, D20).
export const CODE_TASK_TYPES = ['task', 'bug'] as const satisfies readonly TaskType[]

export function deliversCode(type: TaskType): boolean {
  return (CODE_TASK_TYPES as readonly TaskType[]).includes(type)
}

// D19/D20: spikes and designs always go to Human review, whatever their flag says
export function requiresHumanReview(type: TaskType, humanReview: boolean): boolean {
  return !deliversCode(type) || humanReview
}

// A subtask on the negotiated PR-free protocol submits commits to its
// parent's branch instead of opening a PR (D27). 0 is the PR path.
export function isPrFree(task: { integrationProtocol: number }): boolean {
  return task.integrationProtocol > 0
}

// Whether the task's own flag asks for Human review (D27, D28): a PR-free
// subtask's flag and human checks wait for its task's approval instead.
// Designs and spikes go to Human review whatever this says.
export function humanReviewFlag(task: { humanReview: boolean, integrationProtocol: number }): boolean {
  return !isPrFree(task) && task.humanReview
}

// The deliverable type is fixed once work is approved or awaiting merge. Spikes
// and designs have their own flow to the end (D19, D20), so a task can't enter
// or leave those types once it has left Draft or Backlog: a retyped design
// could otherwise be approved into Ready to merge.
export function canChangeType(task: { status: TaskStatus, type: TaskType }, to: TaskType): boolean {
  if (to === task.type) return true
  if (['approved', 'ready_to_merge', 'merged'].includes(task.status)) return false
  if (task.status === 'draft' || task.status === 'backlog') return true
  return [task.type, to].every(deliversCode)
}

// Task IDs are PREFIX-NUMBER, e.g. COR-29 (D13)
export function taskRef(prefix: string, number: number): string {
  return `${prefix}-${number}`
}

// Matches any PREFIX-NUMBER, in either case; whether the prefix is a project's
// is for the lookup to say
export const TASK_REF_PATTERN = /^([A-Za-z]+)-(\d+)$/

export function parseTaskRef(ref: string): { prefix: string, number: number } | null {
  const match = TASK_REF_PATTERN.exec(ref)
  return match ? { prefix: match[1]!.toUpperCase(), number: Number(match[2]) } : null
}
