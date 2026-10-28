import type { TaskStatus } from './status.ts'

// How a task is deleted (D10, "Deleting"). There's no Cancelled status.
//   hard:        removed outright (Backlog only)
//   soft:        stop the run, close the PR, delete the branch when safe, then
//                hide the task but keep it and its audit history
//   not_allowed: Merged tasks are immutable history
export type Deletion = 'hard' | 'soft' | 'not_allowed'

export function deletionFor(status: TaskStatus): Deletion {
  switch (status) {
    case 'backlog': return 'hard'
    case 'merged': return 'not_allowed'
    default: return 'soft'
  }
}

// Dependents of a deleted task move to Blocked with this reason, unless the
// human removes the dependency first
export const DEPENDENCY_DELETED_REASON = 'A dependency was deleted'
