import type { Task } from '@corral/contracts'
import type { AgentRole, TaskPriority, TaskStatus } from '@corral/core'
import { TASK_PRIORITIES } from '@corral/core'

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
  { key: 'merged', label: 'Merged', statuses: ['merged'], hint: `Last ${MERGED_WINDOW_DAYS} days` },
  { key: 'approved', label: 'Approved', statuses: ['approved'], hint: 'Designs' }
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

// The Board's filters (design/board.md). Each list is a multi-select, and an
// empty list means no filter. They combine with AND.
export interface BoardFilters {
  search: string
  epics: string[]
  // Column keys from BOARD_COLUMNS
  statuses: string[]
  priorities: TaskPriority[]
  // Agent ids
  agents: string[]
}

export const NO_FILTERS: BoardFilters = { search: '', epics: [], statuses: [], priorities: [], agents: [] }

// Which role's turn it is in a column. Tasks aren't assigned ahead of time
// (D15): a task belongs to the agent of its latest run of that role, and to
// no agent of the role before one claims it.
const TURN: Partial<Record<TaskStatus, AgentRole>> = { ready: 'developer', in_progress: 'developer', agent_review: 'reviewer' }

// Leased tasks belong to their holder; otherwise use the latest agent of the turn's role.
export function taskAgentIds(task: Pick<Task, 'status' | 'lease' | 'developer' | 'reviewer'>): string[] {
  if (task.lease) return [task.lease.agentId]
  const role = TURN[task.status]
  const agent = role === 'developer' ? task.developer : role === 'reviewer' ? task.reviewer : null
  return agent ? [agent.id] : []
}

// The agent a Board card shows: the reviewer in Agent review, otherwise the
// developer. It never falls back to the other role.
export function cardAssignee(task: Pick<Task, 'status' | 'developer' | 'reviewer'>): Task['developer'] {
  return task.status === 'agent_review' ? task.reviewer : task.developer
}

// The column a task's status puts it in
export function columnKey(status: TaskStatus): string | undefined {
  return BOARD_COLUMNS.find(c => c.statuses.includes(status))?.key
}

// Whether a task passes the Board's filters: its epic, column, priority and
// agent are among the selected ones (none selected means any), and its ref or
// title matches the search.
export function matchesFilter(task: Pick<Task, 'ref' | 'title' | 'epicId' | 'status' | 'priority'>, filters: BoardFilters, agentIds: string[] = []): boolean {
  const { epics, statuses, priorities, agents, search } = filters
  if (epics.length > 0 && (!task.epicId || !epics.includes(task.epicId))) return false
  if (statuses.length > 0 && !statuses.includes(columnKey(task.status) ?? '')) return false
  if (priorities.length > 0 && !priorities.includes(task.priority)) return false
  if (agents.length > 0 && !agentIds.some(id => agents.includes(id))) return false
  return !search || `${task.ref} ${task.title}`.toLowerCase().includes(search.toLowerCase())
}

export function hasFilters(filters: BoardFilters): boolean {
  return Boolean(filters.search) || filters.epics.length + filters.statuses.length + filters.priorities.length + filters.agents.length > 0
}

// The filters live in the URL query so a filtered Board can be reloaded and
// shared: ?q=, and comma-separated ?epics=, ?status=, ?priority= and ?agent=.
// (?epic= is the epic flyout's.)
const QUERY = { epics: 'epics', statuses: 'status', priorities: 'priority', agents: 'agent' } as const

type Query = Record<string, string | null | (string | null)[] | undefined>

export function filtersFromQuery(query: Query): BoardFilters {
  const first = (value: Query[string]) => (Array.isArray(value) ? value[0] : value) ?? ''
  const list = (key: string) => first(query[key]).split(',').filter(Boolean)
  return {
    search: first(query.q),
    epics: list(QUERY.epics),
    statuses: list(QUERY.statuses).filter(key => BOARD_COLUMNS.some(c => c.key === key)),
    priorities: list(QUERY.priorities).filter((p): p is TaskPriority => (TASK_PRIORITIES as readonly string[]).includes(p)),
    agents: list(QUERY.agents)
  }
}

// The query for a set of filters, keeping the other keys (such as ?column=)
export function filtersToQuery(filters: BoardFilters, query: Query = {}): Query {
  const next: Query = { ...query, q: filters.search || undefined }
  for (const [field, key] of Object.entries(QUERY) as [keyof typeof QUERY, string][]) {
    next[key] = filters[field].length > 0 ? filters[field].join(',') : undefined
  }
  return next
}

// What a filter's trigger reads: "All epics", the one item's name, or
// "N epics".
export function filterLabel(selected: string[], label: (id: string) => string, all: string, plural: string): string {
  if (selected.length === 0) return all
  if (selected.length === 1) return label(selected[0]!)
  return `${selected.length} ${plural}`
}
