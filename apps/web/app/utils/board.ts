import type { Agent, Epic, HumanTransitionInput, Run, Task } from '@corral/contracts'
import type { AgentRole, TaskPriority, TaskStatus } from '@corral/core'
import { availableEvents, TASK_PRIORITIES } from '@corral/core'
import { epicInProgress, isLiveRun } from './labels.ts'

// How long a merged task stays in the Board's Merged column. Older ones are
// still on the Backlog, epic and task pages.
export const MERGED_WINDOW_DAYS = 3
const MERGED_WINDOW_MS = MERGED_WINDOW_DAYS * 24 * 60 * 60 * 1000

// Whether a task belongs on the Board: everything past Backlog, except merged
// tasks older than the window.
export function onBoard(task: Pick<Task, 'status' | 'mergedAt'>, now = Date.now()): boolean {
  if (task.status === 'backlog' || task.status === 'draft') return false
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

// The Board's two views. Tasks is the default until one is chosen.
export type BoardView = 'tasks' | 'epics'

// The view from ?view=, falling back to the one last used
export function boardView(value: unknown, fallback: BoardView): BoardView {
  const first = Array.isArray(value) ? value[0] : value
  return first === 'tasks' || first === 'epics' ? first : fallback
}

// The Epics view's columns, in order (design/board.md). `status` picks the
// colour of the column's dot.
export const EPIC_COLUMNS = [
  { key: 'ready', label: 'Ready', status: 'ready', hint: 'Scheduled next' },
  { key: 'in_progress', label: 'In progress', status: 'in_progress', hint: 'Developer' },
  { key: 'agent_review', label: 'Agent review', status: 'agent_review', hint: 'Reviewer' },
  { key: 'human_review', label: 'Human review', status: 'human_review', hint: 'You' },
  { key: 'ready_to_merge', label: 'Ready to merge', status: 'ready_to_merge', hint: 'Corral' },
  { key: 'blocked', label: 'Blocked', status: 'blocked', hint: 'You' },
  { key: 'done', label: 'Done', status: 'merged', hint: `Last ${MERGED_WINDOW_DAYS} days` }
] as const satisfies { key: string, label: string, status: TaskStatus, hint: string }[]

export type EpicStage = typeof EPIC_COLUMNS[number]['key']

type StageEpic = Pick<Epic, 'reviewMode' | 'branch' | 'reviewState' | 'taskCount' | 'mergedCount'>

// The one column an epic belongs in, from the epic with its live counts and
// its tasks. The checks are ordered. `direct` epics have no epic PR, so their
// review state never counts and they go from In progress to Done.
export function epicStage(epic: StageEpic, tasks: Pick<Task, 'status'>[]): EpicStage {
  const review = epic.reviewMode === 'direct' ? null : epic.reviewState
  if (review === 'conflict' || tasks.some(t => t.status === 'blocked' || t.status === 'failed')) return 'blocked'
  if (epic.taskCount > 0 && !epicInProgress(epic)) return 'done'
  if (review === 'ready_to_merge') return 'ready_to_merge'
  if (review === 'human_review') return 'human_review'
  if (epic.taskCount > 0 && epic.mergedCount === epic.taskCount && (review === null || review === 'open' || review === 'in_review')) return 'agent_review'
  if (tasks.every(t => t.status === 'draft' || t.status === 'backlog' || t.status === 'ready')) return 'ready'
  return 'in_progress'
}

// Whether an epic belongs on the Board: it has work left or tasks on the Board.
// A finished epic stays for the merge window from its last merge. Approved
// designs never leave the Board, so they don't hold a finished epic here, and
// updatedAt covers an epic PR that merged after the tasks' window closed.
export function epicOnBoard(epic: StageEpic & Pick<Epic, 'updatedAt'>, tasks: Pick<Task, 'status' | 'mergedAt'>[], now = Date.now()): boolean {
  if (epicInProgress(epic)) return true
  if (epic.taskCount === 0) return false
  const finished = epic.reviewMode !== 'direct' && epic.reviewState === 'merged' && now - new Date(epic.updatedAt).getTime() <= MERGED_WINDOW_MS
  return finished || tasks.some(t => t.status === 'merged' && onBoard(t, now))
}

// The prerequisite epics still unfinished, for the blocked icon: the same rule
// that holds back their dependents' tasks (holdsEpicOpen on the server). Pass
// epics with live counts.
export function unfinishedPrerequisites<E extends Pick<Epic, 'id' | 'title'> & StageEpic>(epic: Pick<Epic, 'dependsOn'>, epics: E[]): E[] {
  return epics.filter(e => epic.dependsOn.includes(e.id) && epicInProgress(e))
}

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

// Whether an epic passes the Epics view's filters: only the search, on its
// title, and the Epic filter apply there.
export function matchesEpicFilter(epic: Pick<Epic, 'id' | 'title'>, filters: Pick<BoardFilters, 'search' | 'epics'>): boolean {
  if (filters.epics.length > 0 && !filters.epics.includes(epic.id)) return false
  return !filters.search || epic.title.toLowerCase().includes(filters.search.toLowerCase())
}

export function hasFilters(filters: BoardFilters): boolean {
  return Boolean(filters.search) || filters.epics.length + filters.statuses.length + filters.priorities.length + filters.agents.length > 0
}

export function hasEpicFilters(filters: Pick<BoardFilters, 'search' | 'epics'>): boolean {
  return Boolean(filters.search) || filters.epics.length > 0
}

// The filters live in the URL query so a filtered Board can be reloaded and
// shared: ?q=, and comma-separated ?epics=, ?status=, ?priority= and ?agent=.
// (?epic= is the epic flyout's, and ?view= the Tasks / Epics toggle's.)
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

// Dragging uses the same human actions as the task's Status menu. It cannot
// impersonate an agent or move work through scheduler-owned transitions.
export function boardMove(task: Task, status: TaskStatus): HumanTransitionInput | null {
  if (task.status === status) return null
  const events = availableEvents({
    type: task.type, status: task.status, humanReview: task.humanReview,
    reviewRounds: task.reviewRounds, failedRuns: task.failedRuns, reason: task.statusReason
  }, { kind: 'human', userId: 'me' })
  if (events.includes('resolve') && (status === 'ready' || status === 'in_progress' || status === 'backlog')) return { type: 'resolve', to: status }
  if (events.includes('approve') && status === 'ready') return { type: 'approve' }
  if (events.includes('send_back') && status === 'backlog') return { type: 'send_back' }
  if (events.includes('human_request_changes') && task.status !== 'approved' && status === 'in_progress') return { type: 'human_request_changes' }
  return null
}

// Task leases and taskless epic runs are independent sources of working agents.
// Keep shell order stable as leases/runs arrive, and deduplicate by identity.
export function epicWorkingAgents(epicId: string, tasks: Pick<Task, 'epicId' | 'lease'>[], runs: Pick<Run, 'epicId' | 'agentId' | 'state'>[], agents: Agent[]): Agent[] {
  const ids = new Set(tasks.filter(task => task.epicId === epicId && task.lease).map(task => task.lease!.agentId))
  for (const run of runs) {
    if (run.epicId === epicId && isLiveRun(run)) ids.add(run.agentId)
  }
  return agents.filter(agent => ids.has(agent.id))
}
