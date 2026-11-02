import type { EpicReviewMode, EpicReviewState } from './project.ts'
import type { TaskStatus } from './status.ts'

// A parent task's stage, computed on read from its sub-tasks and delivery
// state (D31). It's never stored and never goes through transition().
export const PARENT_STAGES = ['ready', 'in_progress', 'agent_review', 'human_review', 'ready_to_merge', 'blocked', 'done'] as const
export type ParentStage = typeof PARENT_STAGES[number]

export interface ParentDelivery {
  reviewMode: EpicReviewMode
  branch: string | null
  reviewState: EpicReviewState | null
  taskCount: number
  mergedCount: number
}

// Work left: unmerged sub-tasks, or a PR still to merge (D22, D27)
export function deliveryInProgress(delivery: ParentDelivery): boolean {
  if (delivery.taskCount === 0) return false
  return delivery.mergedCount < delivery.taskCount || (delivery.reviewMode !== 'direct' && delivery.branch !== null && delivery.reviewState !== 'merged')
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
  if (tasks.every(t => t.status === 'draft' || t.status === 'backlog' || t.status === 'ready')) return 'ready'
  return 'in_progress'
}

// A task is on its own unless it's a sub-task or parent
export function isParentTask(task: { status: TaskStatus }): boolean {
  return task.status === 'parent'
}
