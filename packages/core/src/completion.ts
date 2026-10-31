import type { TaskStatus } from './status.ts'
import type { TaskType } from './task.ts'

// D19/D20: designs deliver approval; other types finish at Merged.
export const DONE_STATUS = {
  task: 'merged', bug: 'merged', spike: 'merged', design: 'approved'
} as const satisfies Record<TaskType, TaskStatus>

export interface CompletionState {
  type: TaskType
  status: TaskStatus
}

export function isTaskDone(task: CompletionState): boolean {
  return task.status === DONE_STATUS[task.type]
}

export function isUnfinishedBoardTask(task: CompletionState & { deleted?: boolean }): boolean {
  return !task.deleted && task.status !== 'draft' && task.status !== 'backlog' && !isTaskDone(task)
}

// Approved designs remain deletable; merged work is immutable history.
export function isTaskImmutable(task: CompletionState): boolean {
  return task.type !== 'design' && isTaskDone(task)
}
