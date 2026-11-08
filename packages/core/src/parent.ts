import { isTaskDone, isUnfinished, type CompletionState } from './completion.ts'
import type { EpicReviewMode, EpicReviewState } from './project.ts'
import { isNotStarted, isOnBoard, type TaskStatus } from './status.ts'
import { deliversCode, type TaskType } from './task.ts'

// A parent task's stage, computed on read from its sub-tasks and delivery
// state (D31). It's never stored and never goes through transition().
export const PARENT_STAGES = ['ready', 'in_progress', 'agent_review', 'human_review', 'ready_to_merge', 'blocked', 'done'] as const
export type ParentStage = typeof PARENT_STAGES[number]

// A task's delivery record: how its subtasks' work reaches the target branch
export interface DeliveryRecord {
  reviewMode: EpicReviewMode
  branch: string | null
  reviewState: EpicReviewState | null
}

export interface ParentDelivery extends DeliveryRecord {
  taskCount: number
  mergedCount: number
}

// The subtasks' work lands through the task's own PR, which hasn't merged yet
// (D22, D27). A `direct` task merges each subtask straight to the target.
export function deliversThroughPr(delivery: Pick<DeliveryRecord, 'reviewMode' | 'reviewState'>): boolean {
  return delivery.reviewMode !== 'direct' && delivery.reviewState !== 'merged'
}

// As deliversThroughPr, once the task's branch exists: a PR is still to land
export function hasPrToLand(delivery: DeliveryRecord): boolean {
  return deliversThroughPr(delivery) && delivery.branch !== null
}

// Work left: unmerged sub-tasks, or a PR still to merge (D22, D27)
export function deliveryInProgress(delivery: ParentDelivery): boolean {
  if (delivery.taskCount === 0) return false
  return delivery.mergedCount < delivery.taskCount || hasPrToLand(delivery)
}

// Every board subtask is done, so the task is heading for review or merge
export function boardComplete(board: readonly CompletionState[]): boolean {
  return board.length > 0 && board.every(isTaskDone)
}

type Subtask = CompletionState & { deleted?: boolean }

// A board subtask that keeps its task from being done: unfinished, or done
// with its work still waiting on the task's PR (D22, D27)
export function holdsDeliveryOpen(task: Subtask, delivery: DeliveryRecord): boolean {
  return !task.deleted && isOnBoard(task.status) && (isUnfinished(task) || hasPrToLand(delivery))
}

// A dependency whose work isn't on the target branch yet for a task outside
// its task with subtasks, though it may show Merged (D27). One with no
// delivery record never holds, and neither does a spike: its findings aren't
// on the branch.
export function holdsAcrossDeliveries(dependency: Subtask & { epicId: string | null }, delivery: DeliveryRecord | null, dependentEpicId: string | null): boolean {
  return deliversCode(dependency.type) && delivery !== null && dependency.epicId !== dependentEpicId && holdsDeliveryOpen(dependency, delivery)
}

// A task with subtasks holds its dependents until every live subtask is done,
// Backlog and Draft ones too, and its work has landed (D31). One with no live
// subtasks has nothing to wait for.
export function parentHolds(delivery: DeliveryRecord, subtasks: readonly Subtask[]): boolean {
  return subtasks.some(t => !t.deleted && (isUnfinished(t) || holdsDeliveryOpen(t, delivery)))
}

// The one stage a parent is in. The checks are ordered. `direct` parents have
// no PR of their own, so their review state never counts.
export function parentStage(delivery: ParentDelivery, tasks: readonly { status: TaskStatus }[]): ParentStage {
  const review = delivery.reviewMode === 'direct' ? null : delivery.reviewState
  if (review === 'conflict' || tasks.some(t => t.status === 'blocked' || t.status === 'failed')) return 'blocked'
  if (delivery.taskCount > 0 && !deliveryInProgress(delivery)) return 'done'
  if (review === 'ready_to_merge') return 'ready_to_merge'
  if (review === 'human_review') return 'human_review'
  if (delivery.taskCount > 0 && delivery.mergedCount === delivery.taskCount && (review === null || review === 'open' || review === 'in_review')) return 'agent_review'
  if (tasks.every(t => isNotStarted(t.status))) return 'ready'
  return 'in_progress'
}

// Why a task can't gain subtasks, from the task alone (D31). The server also
// refuses work that has had a run, a submission, a PR or a design pin.
export function subtaskRefusal(task: { epicId: string | null, status: TaskStatus, type: TaskType, leased: boolean }): string | null {
  if (task.epicId) return 'A subtask can\'t have subtasks; they go one level deep. Add a separate follow-up task instead.'
  if (!isNotStarted(task.status) || task.leased) return `${task.status === 'merged' ? 'Merged' : 'Started'} work can't gain subtasks. Add a separate follow-up task instead.`
  if (!deliversCode(task.type)) return 'Only a task or a bug can gain subtasks.'
  return null
}

export const canGainSubtasks = (task: Parameters<typeof subtaskRefusal>[0]): boolean => subtaskRefusal(task) === null
