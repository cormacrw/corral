import type { Agent, Epic, HumanTransitionInput, Run, Task } from '@corral/contracts'
import type { AgentRole, ParentStage, ResolveTarget, TaskPriority, TaskStatus } from '@corral/core'
import { availableEvents, completedAt, RESOLVE_TARGETS, deliveryInProgress, DONE_STATUS, isActiveRun, isNotStarted, isOnBoard, isTaskDone, parentStage, TASK_PRIORITIES } from '@corral/core'
import { PRIORITY } from '~/utils/labels.ts'

// How long a completed task stays in the Board's Complete column. Older ones are
// still on the Backlog, epic and task pages.
export const COMPLETE_WINDOW_DAYS = 3
const COMPLETE_WINDOW_MS = COMPLETE_WINDOW_DAYS * 24 * 60 * 60 * 1000

export function onBoard(task: Pick<Task, 'type' | 'status' | 'mergedAt' | 'updatedAt'>, now = Date.now()): boolean {
  if (!isOnBoard(task.status)) return false
  if (!isTaskDone(task)) return true
  const at = completedAt(task)
  return at !== null && now - new Date(at).getTime() <= COMPLETE_WINDOW_MS
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
  { key: 'complete', label: 'Complete', statuses: [...new Set(Object.values(DONE_STATUS))], hint: `Last ${COMPLETE_WINDOW_DAYS} days` }
]

// The Board's two views: top-level tasks, the default until one is chosen, or
// every sub-task (design/board.md)
export type BoardView = 'top' | 'all'
export const BOARD_VIEW_ITEMS = [{ label: 'Top-level', value: 'top' }, { label: 'All subtasks', value: 'all' }]

// The view from ?view=, falling back to the one last used. Links from before
// parent tasks say `epics` for cards per parent and `tasks` for every task.
export function boardView(value: unknown, fallback: BoardView): BoardView {
  const first = Array.isArray(value) ? value[0] : value
  if (first === 'top' || first === 'epics') return 'top'
  return first === 'all' || first === 'tasks' ? 'all' : fallback
}

export const parentColumn = (stage: ParentStage): string => stage === 'done' ? 'complete' : stage

export function columnEntries<C extends { epic: Pick<Epic, 'mergedAt' | 'createdAt'> }, T extends Pick<Task, 'ref' | 'type' | 'status' | 'mergedAt' | 'updatedAt'>>(key: string, tasks: T[], cards: C[]) {
  const sorted = sortColumn(key, tasks)
  const entries: { card?: C, task?: T, at: number }[] = [
    ...cards.map(card => ({ card, at: new Date(card.epic.mergedAt ?? card.epic.createdAt).getTime() })),
    ...sorted.map(task => ({ task, at: new Date(completedAt(task) ?? 0).getTime() }))
  ]
  return { tasks: sorted, cards, entries: key === 'complete' ? entries.sort((a, b) => b.at - a.at) : entries }
}

export const isTopLevel = (task: Pick<Task, 'parentTask'>): boolean => task.parentTask === null

type StageEpic = Pick<Epic, 'reviewMode' | 'branch' | 'reviewState' | 'taskCount' | 'mergedCount'>

// Overview filters overlap deliberately: started, unfinished epics are also Open.
// Pass epicWithLiveCounts so task events can move an epic between filters.
type OverviewEpicFilter = 'open' | 'in-progress' | 'closed'

export function matchesOverviewEpicFilter(epic: StageEpic, tasks: Pick<Task, 'status'>[], filter: OverviewEpicFilter): boolean {
  const finished = parentStage(epic, tasks) === 'done'
  if (filter === 'closed') return finished
  if (finished) return false
  return filter === 'open' || tasks.some(task => !isNotStarted(task.status))
}

// Whether an epic belongs on the Board: it has work left or tasks on the Board.
// A finished epic stays while one of its done tasks is still in Complete, and
// mergedAt covers a PR that merged after the tasks' window closed.
export function epicOnBoard(epic: StageEpic & Pick<Epic, 'mergedAt'>, tasks: Pick<Task, 'type' | 'status' | 'mergedAt' | 'updatedAt'>[], now = Date.now()): boolean {
  if (deliveryInProgress(epic)) return true
  if (epic.taskCount === 0) return false
  const finished = epic.mergedAt !== null && now - new Date(epic.mergedAt).getTime() <= COMPLETE_WINDOW_MS
  return finished || tasks.some(t => isTaskDone(t) && onBoard(t, now))
}

// The prerequisite epics still unfinished, for the blocked icon: the same rule
// that holds back their dependents' tasks (holdsEpicOpen on the server). Pass
// epics with live counts.
export function unfinishedPrerequisites<E extends Pick<Epic, 'id' | 'title'> & StageEpic>(epic: Pick<Epic, 'dependsOn'>, epics: E[]): E[] {
  return epics.filter(e => epic.dependsOn.includes(e.id) && deliveryInProgress(e))
}

// How far a finger must travel sideways, in px, to count as a swipe
const SWIPE_DISTANCE = 50

// Which way a touch moved the mobile Board: 1 to the next column (swiping
// left), -1 to the previous one, 0 when it was a tap or a vertical scroll.
export function swipeStep(dx: number, dy: number): -1 | 0 | 1 {
  if (Math.abs(dx) < SWIPE_DISTANCE || Math.abs(dx) <= Math.abs(dy)) return 0
  return dx < 0 ? 1 : -1
}

export function sortColumn<T extends Pick<Task, 'ref' | 'type' | 'status' | 'mergedAt' | 'updatedAt'>>(key: string, tasks: T[]): T[] {
  if (key !== 'complete') return tasks
  const time = (task: T) => {
    const at = completedAt(task)
    return at === null ? -Infinity : new Date(at).getTime()
  }
  return [...tasks].sort((a, b) => time(b) - time(a) || a.ref.localeCompare(b.ref, undefined, { numeric: true }))
}

// Preserve saved Board links from before the combined column.
export function boardColumnKey<T>(key: T): T | 'complete' {
  return key === 'merged' || key === 'approved' ? 'complete' : key
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

export function taskAgentIds(task: Pick<Task, 'status' | 'lease' | 'developer' | 'reviewer'>): string[] {
  if (task.lease) return [task.lease.agentId]
  const role = TURN[task.status]
  const agent = role === 'developer' ? task.developer : role === 'reviewer' ? task.reviewer : null
  return agent ? [agent.id] : []
}

export function cardAssignee(task: Pick<Task, 'status' | 'developer' | 'reviewer'>): Task['developer'] {
  return task.status === 'agent_review' ? task.reviewer : task.developer
}

export function columnKey(status: TaskStatus): string | undefined {
  return BOARD_COLUMNS.find(c => c.statuses.includes(status))?.key
}

export function matchesFilter(task: Pick<Task, 'ref' | 'title' | 'epicId' | 'status' | 'priority'>, filters: BoardFilters, agentIds: string[] = []): boolean {
  const { epics, statuses, priorities, agents, search } = filters
  if (epics.length > 0 && (!task.epicId || !epics.includes(task.epicId))) return false
  if (statuses.length > 0 && !statuses.includes(columnKey(task.status) ?? '')) return false
  if (priorities.length > 0 && !priorities.includes(task.priority)) return false
  if (agents.length > 0 && !agentIds.some(id => agents.includes(id))) return false
  return !search || `${task.ref} ${task.title}`.toLowerCase().includes(search.toLowerCase())
}

export function matchesEpicFilter(epic: Pick<Epic, 'id' | 'title'>, filters: Pick<BoardFilters, 'search' | 'epics'>): boolean {
  if (filters.epics.length > 0 && !filters.epics.includes(epic.id)) return false
  return !filters.search || epic.title.toLowerCase().includes(filters.search.toLowerCase())
}

export function matchesParentFilter(card: { workingAgents: Pick<Agent, 'id'>[] }, parent: Pick<Task, 'priority'> | undefined, filters: Pick<BoardFilters, 'priorities' | 'agents'>): boolean {
  if (filters.priorities.length > 0 && !(parent && filters.priorities.includes(parent.priority))) return false
  return filters.agents.length === 0 || card.workingAgents.some(agent => filters.agents.includes(agent.id))
}

export function hasFilters(filters: BoardFilters): boolean {
  return Boolean(filters.search) || filters.epics.length + filters.statuses.length + filters.priorities.length + filters.agents.length > 0
}

export function boardFilterGroups(epics: { id: string, label: string }[], agents: { id: string, name: string }[]) {
  return [
    { key: 'epics', name: 'Task with subtasks', plural: 'tasks with subtasks', icon: 'i-hugeicons-hierarchy', items: epics.map(e => ({ value: e.id, label: e.label })) },
    { key: 'statuses', name: 'Status', plural: 'statuses', icon: 'i-hugeicons-layout-2-column', items: BOARD_COLUMNS.map(c => ({ value: c.key, label: c.label })) },
    { key: 'priorities', name: 'Priority', plural: 'priorities', icon: 'i-hugeicons-wifi-01', items: Object.entries(PRIORITY).map(([value, p]) => ({ value, label: p.label })) },
    { key: 'agents', name: 'Agent', plural: 'agents', icon: 'i-hugeicons-robot-01', items: agents.map(a => ({ value: a.id, label: a.name })) }
  ] as const
}

export function activeFilterCount(filters: BoardFilters): number {
  return [filters.epics, filters.statuses, filters.priorities, filters.agents].filter(values => values.length > 0).length
}

// The filters live in the URL query so a filtered Board can be reloaded and
// shared: ?q=, and comma-separated ?epics=, ?status=, ?priority= and ?agent=.
// (?epic= is the epic flyout's, and ?view= the Top-level / All subtasks toggle's.)
const QUERY = { epics: 'epics', statuses: 'status', priorities: 'priority', agents: 'agent' } as const

type Query = Record<string, string | null | (string | null)[] | undefined>

export function filtersFromQuery(query: Query): BoardFilters {
  const first = (value: Query[string]) => (Array.isArray(value) ? value[0] : value) ?? ''
  const list = (key: string) => first(query[key]).split(',').filter(Boolean)
  return {
    search: first(query.q),
    epics: list(QUERY.epics),
    statuses: [...new Set(list(QUERY.statuses).map(boardColumnKey))].filter(key => BOARD_COLUMNS.some(c => c.key === key)),
    priorities: list(QUERY.priorities).filter((p): p is TaskPriority => (TASK_PRIORITIES as readonly string[]).includes(p)),
    agents: list(QUERY.agents)
  }
}

export function filtersToQuery(filters: BoardFilters, query: Query = {}): Query {
  const next: Query = { ...query, q: filters.search || undefined }
  for (const [field, key] of Object.entries(QUERY) as [keyof typeof QUERY, string][]) {
    next[key] = filters[field].length > 0 ? filters[field].join(',') : undefined
  }
  return next
}

export function filterLabel(selected: string[], label: (id: string) => string, all: string, plural: string): string {
  if (selected.length === 0) return all
  if (selected.length === 1) return label(selected[0]!)
  return `${selected.length} ${plural}`
}

// The human moves a task to a status: by dragging on the Board or from the
// task's Status menu. It cannot impersonate an agent or move work through
// scheduler-owned transitions.
const isResolveTarget = (status: TaskStatus): status is ResolveTarget => (RESOLVE_TARGETS as readonly TaskStatus[]).includes(status)

export function boardMove(task: Pick<Task, 'status' | 'type'>, status: TaskStatus): HumanTransitionInput | null {
  if (task.status === status) return null
  const events = availableEvents(task, { kind: 'human', userId: 'me' })
  if (events.includes('resolve') && isResolveTarget(status)) return { type: 'resolve', to: status }
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
    if (run.epicId === epicId && isActiveRun(run.state)) ids.add(run.agentId)
  }
  return agents.filter(agent => ids.has(agent.id))
}
