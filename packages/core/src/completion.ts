import { isOnBoard, type TaskStatus } from './status.ts'
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

// A task with subtasks is never finished by type: parentHolds decides for one
export function isUnfinished(task: CompletionState): boolean {
  return task.status !== 'parent' && !isTaskDone(task)
}

export function isUnfinishedBoardTask(task: CompletionState & { deleted?: boolean }): boolean {
  return !task.deleted && isOnBoard(task.status) && !isTaskDone(task)
}

// What a task with subtasks counts: its live subtasks on the board, and how
// many of those are done (D31)
export function deliveryCounts(tasks: readonly (CompletionState & { deleted?: boolean })[]): { taskCount: number, mergedCount: number } {
  const counted = tasks.filter(t => !t.deleted && isOnBoard(t.status))
  return { taskCount: counted.length, mergedCount: counted.filter(isTaskDone).length }
}

// Designs have no merge event; approval updates the task's timestamp.
export function completedAt(task: CompletionState & { mergedAt: string | null, updatedAt: string }): string | null {
  return task.type === 'design' && isTaskDone(task) ? task.mergedAt ?? task.updatedAt : task.mergedAt
}

// Approved designs remain deletable; merged work is immutable history.
export function isTaskImmutable(task: CompletionState): boolean {
  return task.type !== 'design' && isTaskDone(task)
}
