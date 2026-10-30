import { isTaskImmutable, type CompletionState } from './completion.ts'

// How a task is deleted (D10, "Deleting"). There's no Cancelled status.
//   hard:        removed outright (Draft and Backlog)
//   soft:        stop the run, close the PR, delete the branch when safe, then
//                hide the task but keep it and its audit history
//   not_allowed: Merged tasks are immutable history
export type Deletion = 'hard' | 'soft' | 'not_allowed'

export function deletionFor(task: CompletionState): Deletion {
  if (isTaskImmutable(task)) return 'not_allowed'
  switch (task.status) {
    case 'draft':
    case 'backlog': return 'hard'
    default: return 'soft'
  }
}

// Dependents of a deleted task move to Blocked with this reason, unless the
// human removes the dependency first
export const DEPENDENCY_DELETED_REASON = 'A dependency was deleted'
