import type { Task } from '@corral/contracts'

type CompletionTask = Pick<Task, 'type' | 'status' | 'mergedAt' | 'updatedAt'>

// Designs have no merge event; approval updates the task's timestamp.
export function completedAt(task: CompletionTask): string | null {
  return task.type === 'design' && task.status === 'approved' ? task.mergedAt ?? task.updatedAt : task.mergedAt
}
