import type { Task } from '@corral/contracts'
import type { TaskStatus } from '@corral/core'

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

// The Board's columns, in order (design/board.md). The key names a column in
// the mobile Board's ?column= query.
export const BOARD_COLUMNS: { key: string, label: string, statuses: TaskStatus[], hint: string }[] = [
  { key: 'ready', label: 'Ready', statuses: ['ready'], hint: 'Scheduled next' },
  { key: 'in_progress', label: 'In progress', statuses: ['in_progress'], hint: 'Developer' },
  { key: 'agent_review', label: 'Agent review', statuses: ['agent_review'], hint: 'Reviewer' },
  { key: 'human_review', label: 'Human review', statuses: ['human_review'], hint: 'You' },
  { key: 'ready_to_merge', label: 'Ready to merge', statuses: ['ready_to_merge'], hint: 'Corral' },
  { key: 'blocked', label: 'Blocked & failed', statuses: ['blocked', 'failed'], hint: 'You' },
  { key: 'merged', label: 'Merged', statuses: ['merged'], hint: `Last ${MERGED_WINDOW_DAYS} days` }
]

// How far a finger must travel sideways, in px, to count as a swipe
export const SWIPE_DISTANCE = 50

// Which way a touch moved the mobile Board: 1 to the next column (swiping
// left), -1 to the previous one, 0 when it was a tap or a vertical scroll.
export function swipeStep(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) <= Math.abs(dy)) return 0
  return dx < 0 ? 1 : -1
}

// Orders a column's tasks. Merged lists the newest merge first, with tasks that
// have no merge time last and ties broken by ref so the order is stable. Other
// columns keep the order they came in.
export function sortColumn<T extends Pick<Task, 'ref' | 'mergedAt'>>(key: string, tasks: T[]): T[] {
  if (key !== 'merged') return tasks
  const time = (t: T) => t.mergedAt === null ? -Infinity : new Date(t.mergedAt).getTime()
  return [...tasks].sort((a, b) => time(b) - time(a) || a.ref.localeCompare(b.ref, undefined, { numeric: true }))
}

// Whether a task passes the Board's filters: its epic is one of the selected
// epics (none selected means all epics), and its ref or title matches the
// search.
export function matchesFilter(task: Pick<Task, 'ref' | 'title' | 'epicId'>, epics: string[], search: string): boolean {
  if (epics.length > 0 && (!task.epicId || !epics.includes(task.epicId))) return false
  return !search || `${task.ref} ${task.title}`.toLowerCase().includes(search.toLowerCase())
}

// What the epic filter's trigger reads: "All epics", the one epic's name, or
// "N epics".
export function epicFilterLabel(epics: string[], label: (id: string) => string): string {
  if (epics.length === 0) return 'All epics'
  if (epics.length === 1) return label(epics[0]!)
  return `${epics.length} epics`
}
