import type { Task } from '@corral/contracts'

// How long a merged task stays in the Board's Merged column. Older ones are
// still on the Backlog, epic and task pages.
export const MERGED_WINDOW_DAYS = 3
const MERGED_WINDOW_MS = MERGED_WINDOW_DAYS * 24 * 60 * 60 * 1000

// Whether a task belongs on the Board: everything past Backlog, except merged
// tasks older than the window.
export function onBoard(task: Pick<Task, 'status' | 'mergedAt'>, now = Date.now()): boolean {
  if (task.status === 'backlog') return false
  if (task.status !== 'merged') return true
  return task.mergedAt !== null && now - new Date(task.mergedAt).getTime() <= MERGED_WINDOW_MS
}
