import { describe, expect, it } from 'vitest'
import type { Task } from '@corral/contracts'
import type { BoardFilters } from './board.ts'
import { BOARD_COLUMNS, boardMove, boardView, EPIC_COLUMNS, epicOnBoard, epicStage, epicWorkingAgents, filterLabel, filtersFromQuery, filtersToQuery, hasEpicFilters, hasFilters, matchesEpicFilter, matchesFilter, MERGED_WINDOW_DAYS, NO_FILTERS, onBoard, sortColumn, swipeStep, taskAgentIds, unfinishedPrerequisites } from './board.ts'

const DAY = 24 * 60 * 60 * 1000
const now = Date.parse('2026-10-29T12:00:00Z')
const mergedAgo = (ms: number) => ({ status: 'merged' as const, mergedAt: new Date(now - ms).toISOString() })

describe('onBoard', () => {
  it('uses a 3-day window', () => {
    expect(MERGED_WINDOW_DAYS).toBe(3)
  })

  it('shows a task merged 2 days ago and hides one merged 4 days ago', () => {
    expect(onBoard(mergedAgo(2 * DAY), now)).toBe(true)
    expect(onBoard(mergedAgo(4 * DAY), now)).toBe(false)
  })

  it('keeps a task merged just inside 3 days and drops one just outside', () => {
    expect(onBoard(mergedAgo(3 * DAY - 1000), now)).toBe(true)
    expect(onBoard(mergedAgo(3 * DAY), now)).toBe(true)
    expect(onBoard(mergedAgo(3 * DAY + 1000), now)).toBe(false)
  })

  it('hides merged tasks with no merge time', () => {
    expect(onBoard({ status: 'merged', mergedAt: null }, now)).toBe(false)
  })

  it('leaves other statuses alone and keeps Backlog off the board', () => {
    expect(onBoard({ status: 'ready', mergedAt: null }, now)).toBe(true)
    expect(onBoard({ status: 'blocked', mergedAt: null }, now)).toBe(true)
    expect(onBoard({ status: 'backlog', mergedAt: null }, now)).toBe(false)
    expect(onBoard({ status: 'draft', mergedAt: null }, now)).toBe(false)
  })
})

describe('BOARD_COLUMNS', () => {
  it('covers every status past Backlog exactly once', () => {
    const statuses = BOARD_COLUMNS.flatMap(c => c.statuses)
    expect(new Set(statuses).size).toBe(statuses.length)
    expect(statuses.sort()).toEqual(['agent_review', 'approved', 'blocked', 'failed', 'human_review', 'in_progress', 'merged', 'ready', 'ready_to_merge'])
  })

  it('has unique keys', () => {
    expect(new Set(BOARD_COLUMNS.map(c => c.key)).size).toBe(BOARD_COLUMNS.length)
  })
})

describe('swipeStep', () => {
  it('moves to the next column on a swipe left and the previous on a swipe right', () => {
    expect(swipeStep(-80, 10)).toBe(1)
    expect(swipeStep(80, -10)).toBe(-1)
  })

  it('ignores taps and short drags', () => {
    expect(swipeStep(0, 0)).toBe(0)
    expect(swipeStep(-30, 0)).toBe(0)
  })

  it('ignores mostly vertical scrolls', () => {
    expect(swipeStep(-60, 120)).toBe(0)
  })
})

describe('sortColumn', () => {
  const task = (ref: string, mergedAt: string | null) => ({ ref, mergedAt })
  const refs = (tasks: { ref: string }[]) => tasks.map(t => t.ref)

  it('lists merged tasks newest first', () => {
    const tasks = [
      task('COR-1', '2026-10-27T09:00:00Z'),
      task('COR-2', '2026-10-29T09:00:00Z'),
      task('COR-3', '2026-10-28T09:00:00Z')
    ]
    expect(refs(sortColumn('merged', tasks))).toEqual(['COR-2', 'COR-3', 'COR-1'])
  })

  it('puts tasks with no merge time last', () => {
    const tasks = [task('COR-1', null), task('COR-2', '2026-10-27T09:00:00Z'), task('COR-3', null), task('COR-4', '2026-10-28T09:00:00Z')]
    expect(refs(sortColumn('merged', tasks))).toEqual(['COR-4', 'COR-2', 'COR-1', 'COR-3'])
  })

  it('breaks ties by ref, whatever order they came in', () => {
    const at = '2026-10-28T09:00:00Z'
    const expected = ['COR-2', 'COR-10', 'COR-11']
    expect(refs(sortColumn('merged', [task('COR-11', at), task('COR-2', at), task('COR-10', at)]))).toEqual(expected)
    expect(refs(sortColumn('merged', [task('COR-10', at), task('COR-11', at), task('COR-2', at)]))).toEqual(expected)
  })

  it('does not change the input', () => {
    const tasks = [task('COR-1', '2026-10-27T09:00:00Z'), task('COR-2', '2026-10-29T09:00:00Z')]
    sortColumn('merged', tasks)
    expect(refs(tasks)).toEqual(['COR-1', 'COR-2'])
  })

  it('leaves other columns in the order they came', () => {
    const tasks = [task('COR-3', '2026-10-27T09:00:00Z'), task('COR-1', null), task('COR-2', '2026-10-29T09:00:00Z')]
    for (const column of BOARD_COLUMNS.filter(c => c.key !== 'merged')) {
      expect(refs(sortColumn(column.key, tasks))).toEqual(['COR-3', 'COR-1', 'COR-2'])
    }
  })
})

describe('matchesFilter', () => {
  const tasks = [
    { ref: 'TA-1', title: 'Login form', epicId: 'auth', status: 'ready' as const, priority: 'high' as const },
    { ref: 'TA-2', title: 'Logout button', epicId: 'auth', status: 'in_progress' as const, priority: 'low' as const },
    { ref: 'TA-3', title: 'Billing page', epicId: 'billing', status: 'blocked' as const, priority: 'urgent' as const },
    { ref: 'TA-4', title: 'Login audit log', epicId: 'audit', status: 'failed' as const, priority: 'high' as const },
    { ref: 'TA-5', title: 'Loose task', epicId: null, status: 'merged' as const, priority: 'medium' as const }
  ]
  const refs = (epics: string[], search = '') => tasks.filter(t => matchesFilter(t, { ...NO_FILTERS, epics, search })).map(t => t.ref)
  const match = (filters: Partial<typeof NO_FILTERS>, agentIds: Record<string, string[]> = {}) =>
    tasks.filter(t => matchesFilter(t, { ...NO_FILTERS, ...filters }, agentIds[t.ref] ?? [])).map(t => t.ref)

  it('shows every task when no epic is selected', () => {
    expect(refs([])).toEqual(['TA-1', 'TA-2', 'TA-3', 'TA-4', 'TA-5'])
  })

  it('shows only tasks from the one selected epic', () => {
    expect(refs(['billing'])).toEqual(['TA-3'])
  })

  it('shows tasks from every selected epic, and none without an epic', () => {
    expect(refs(['auth', 'audit'])).toEqual(['TA-1', 'TA-2', 'TA-4'])
  })

  it('combines the epics with search', () => {
    expect(refs(['auth', 'audit'], 'login')).toEqual(['TA-1', 'TA-4'])
    expect(refs([], 'ta-3')).toEqual(['TA-3'])
  })

  it('shows only the selected priorities', () => {
    expect(match({ priorities: ['high'] })).toEqual(['TA-1', 'TA-4'])
    expect(match({ priorities: ['urgent', 'low'] })).toEqual(['TA-2', 'TA-3'])
  })

  it('shows only the selected columns, with Blocked & failed covering both statuses', () => {
    expect(match({ statuses: ['blocked'] })).toEqual(['TA-3', 'TA-4'])
    expect(match({ statuses: ['ready', 'merged'] })).toEqual(['TA-1', 'TA-5'])
  })

  it('shows only tasks one of the selected agents holds or is assigned', () => {
    const agentIds = { 'TA-1': ['dev'], 'TA-2': ['dev', 'rev'], 'TA-3': [] }
    expect(match({ agents: ['rev'] }, agentIds)).toEqual(['TA-2'])
    expect(match({ agents: ['dev', 'rev'] }, agentIds)).toEqual(['TA-1', 'TA-2'])
  })

  it('combines every filter with AND', () => {
    expect(match({ priorities: ['high'], statuses: ['blocked'] })).toEqual(['TA-4'])
    expect(match({ priorities: ['high'], epics: ['auth'], search: 'login' })).toEqual(['TA-1'])
    expect(match({ priorities: ['high'], epics: ['billing'] })).toEqual([])
  })
})

describe('taskAgentIds', () => {
  const developer = { id: 'dev2', name: 'Bolt' }
  const reviewer = { id: 'rev', name: 'Vera' }
  const lease = (role: 'developer' | 'reviewer') => ({ agentId: role === 'developer' ? 'dev2' : 'rev', runId: 'r', role, expiresAt: '' })

  it('belongs to no agent before one claims it (D15)', () => {
    expect(taskAgentIds({ status: 'ready', lease: null, developer: null, reviewer: null })).toEqual([])
    expect(taskAgentIds({ status: 'agent_review', lease: null, developer, reviewer: null })).toEqual([])
  })

  it('assigns the developer columns to the task\'s developer and Agent review to its reviewer', () => {
    expect(taskAgentIds({ status: 'ready', lease: null, developer, reviewer })).toEqual(['dev2'])
    expect(taskAgentIds({ status: 'agent_review', lease: null, developer, reviewer })).toEqual(['rev'])
    expect(taskAgentIds({ status: 'human_review', lease: null, developer, reviewer })).toEqual([])
  })

  it('uses only the agent holding the lease', () => {
    expect(taskAgentIds({ status: 'in_progress', lease: lease('developer'), developer: { id: 'dev', name: 'Other developer' }, reviewer })).toEqual(['dev2'])
    expect(taskAgentIds({ status: 'in_progress', lease: lease('reviewer'), developer, reviewer })).toEqual(['rev'])
  })
})

describe('filters in the URL query', () => {
  it('round-trips every filter and keeps other keys', () => {
    const filters = { search: 'login', epics: ['e1', 'e2'], statuses: ['ready', 'blocked'], priorities: ['high' as const], agents: ['a1'] }
    const query = filtersToQuery(filters, { column: 'ready' })
    expect(query).toEqual({ column: 'ready', q: 'login', epics: 'e1,e2', status: 'ready,blocked', priority: 'high', agent: 'a1' })
    expect(filtersFromQuery(query)).toEqual(filters)
  })

  it('drops empty filters from the query and ignores unknown values', () => {
    expect(filtersToQuery(NO_FILTERS, { column: 'ready', status: 'ready' })).toEqual({ column: 'ready', q: undefined, epics: undefined, status: undefined, priority: undefined, agent: undefined })
    expect(filtersFromQuery({ status: 'nope,merged', priority: 'huge,low' })).toEqual({ ...NO_FILTERS, statuses: ['merged'], priorities: ['low'] })
  })

  it('knows when anything is filtered', () => {
    expect(hasFilters(NO_FILTERS)).toBe(false)
    expect(hasFilters({ ...NO_FILTERS, agents: ['a1'] })).toBe(true)
    expect(hasFilters({ ...NO_FILTERS, search: 'x' })).toBe(true)
  })
})

describe('filterLabel', () => {
  const names: Record<string, string> = { auth: 'Auth', billing: 'Billing' }
  const label = (id: string) => names[id]!

  it('reads All epics, the epic name, or N epics', () => {
    expect(filterLabel([], label, 'All epics', 'epics')).toBe('All epics')
    expect(filterLabel(['billing'], label, 'All epics', 'epics')).toBe('Billing')
    expect(filterLabel(['auth', 'billing'], label, 'All epics', 'epics')).toBe('2 epics')
  })
})

describe('boardMove', () => {
  const task = (status: Task['status'], type: Task['type'] = 'task') => ({ type, status, humanReview: true, reviewRounds: 0, failedRuns: 0, statusReason: null }) as Task

  it('offers the existing human resolution and request-changes actions', () => {
    expect(boardMove(task('blocked'), 'ready')).toEqual({ type: 'resolve', to: 'ready' })
    expect(boardMove(task('failed'), 'in_progress')).toEqual({ type: 'resolve', to: 'in_progress' })
    expect(boardMove(task('human_review'), 'in_progress')).toEqual({ type: 'human_request_changes' })
  })

  it('cannot claim, submit, merge, or repeat the current status by dragging', () => {
    expect(boardMove(task('ready'), 'in_progress')).toBeNull()
    expect(boardMove(task('in_progress'), 'agent_review')).toBeNull()
    expect(boardMove(task('ready_to_merge'), 'merged')).toBeNull()
    expect(boardMove(task('blocked'), 'blocked')).toBeNull()
  })

  it('keeps approved-design changes in the feedback action', () => {
    expect(boardMove(task('approved', 'design'), 'in_progress')).toBeNull()
  })
})

describe('boardView', () => {
  it('lets the URL win over the view last used', () => {
    expect(boardView('epics', 'tasks')).toBe('epics')
    expect(boardView('tasks', 'epics')).toBe('tasks')
    expect(boardView(['epics', 'tasks'], 'tasks')).toBe('epics')
  })

  it('falls back when the URL has no valid view', () => {
    expect(boardView(undefined, 'epics')).toBe('epics')
    expect(boardView('nonsense', 'tasks')).toBe('tasks')
  })
})

describe('epicStage', () => {
  const epic = (over: Partial<Parameters<typeof epicStage>[0]> = {}) => ({
    reviewMode: 'epic' as const, branch: 'corral/epic', reviewState: null, taskCount: 2, mergedCount: 1, ...over
  })
  const merged = [{ status: 'merged' as const }, { status: 'merged' as const }]
  const allMerged = { mergedCount: 2 }

  it('has a column for every stage, in the Board order', () => {
    expect(EPIC_COLUMNS.map(c => c.label)).toEqual(['Ready', 'In progress', 'Agent review', 'Human review', 'Ready to merge', 'Blocked', 'Done'])
  })

  it('blocks on a conflict or a Blocked or Failed task, ahead of everything else', () => {
    expect(epicStage(epic({ ...allMerged, reviewState: 'conflict' }), merged)).toBe('blocked')
    expect(epicStage(epic(), [{ status: 'merged' }, { status: 'blocked' }])).toBe('blocked')
    expect(epicStage(epic({ reviewState: 'human_review' }), [{ status: 'failed' }, { status: 'merged' }])).toBe('blocked')
  })

  it('is done once nothing is left, epic PR included', () => {
    expect(epicStage(epic({ ...allMerged, reviewState: 'merged' }), merged)).toBe('done')
    expect(epicStage(epic({ ...allMerged, branch: null }), merged)).toBe('done')
  })

  it('follows the epic PR', () => {
    expect(epicStage(epic({ ...allMerged, reviewState: 'ready_to_merge' }), merged)).toBe('ready_to_merge')
    expect(epicStage(epic({ ...allMerged, reviewState: 'human_review' }), merged)).toBe('human_review')
  })

  it('is in Agent review once all tasks merged and the PR awaits the reviewer', () => {
    for (const reviewState of [null, 'open', 'in_review'] as const) {
      expect(epicStage(epic({ ...allMerged, reviewState }), merged)).toBe('agent_review')
    }
  })

  it('is Ready until a task starts', () => {
    expect(epicStage(epic({ mergedCount: 0 }), [{ status: 'ready' }, { status: 'backlog' }])).toBe('ready')
  })

  it('is In progress for everything else, including changes requested', () => {
    expect(epicStage(epic(), [{ status: 'merged' }, { status: 'ready' }])).toBe('in_progress')
    expect(epicStage(epic({ mergedCount: 0 }), [{ status: 'human_review' }, { status: 'ready' }])).toBe('in_progress')
    expect(epicStage(epic({ ...allMerged, reviewState: 'changes_requested' }), merged)).toBe('in_progress')
    expect(epicStage(epic({ reviewState: 'open' }), [{ status: 'merged' }, { status: 'in_progress' }])).toBe('in_progress')
  })

  it('takes a direct epic from In progress to Done with no review column', () => {
    const direct = { reviewMode: 'direct' as const, branch: null }
    expect(epicStage(epic(direct), [{ status: 'merged' }, { status: 'in_progress' }])).toBe('in_progress')
    expect(epicStage(epic({ ...direct, ...allMerged }), merged)).toBe('done')
    for (const reviewState of ['open', 'in_review', 'human_review', 'ready_to_merge'] as const) {
      expect(epicStage(epic({ ...direct, ...allMerged, reviewState }), merged)).toBe('done')
    }
  })
})

describe('epicOnBoard', () => {
  const epic = (over: Partial<Parameters<typeof epicOnBoard>[0]> = {}) => ({
    reviewMode: 'epic' as const, branch: 'corral/epic', reviewState: null, taskCount: 1, mergedCount: 1, updatedAt: new Date(now - 10 * DAY).toISOString(), ...over
  })
  const old = mergedAgo(10 * DAY)

  it('keeps an epic with its PR awaiting the human after its tasks leave the window', () => {
    expect(epicOnBoard(epic({ reviewState: 'human_review' }), [old], now)).toBe(true)
  })

  it('hides an epic with no tasks past Backlog', () => {
    expect(epicOnBoard(epic({ taskCount: 0, mergedCount: 0, branch: null }), [], now)).toBe(false)
  })

  it('shows a finished epic for the merge window', () => {
    const direct = epic({ reviewMode: 'direct', branch: null })
    expect(epicOnBoard(direct, [mergedAgo(DAY)], now)).toBe(true)
    expect(epicOnBoard(direct, [old], now)).toBe(false)
  })

  it('counts the window from the epic PR merge when that came later', () => {
    const merged = { reviewState: 'merged' as const }
    expect(epicOnBoard(epic({ ...merged, updatedAt: new Date(now - DAY).toISOString() }), [old], now)).toBe(true)
    expect(epicOnBoard(epic(merged), [old], now)).toBe(false)
  })

  it('does not let an approved design hold a finished epic on the Board', () => {
    expect(epicOnBoard(epic({ reviewMode: 'direct', branch: null }), [{ status: 'approved', mergedAt: null }], now)).toBe(false)
  })
})

describe('unfinishedPrerequisites', () => {
  const epic = (id: string, over = {}) => ({ id, title: id, reviewMode: 'direct' as const, branch: null, reviewState: null, taskCount: 2, mergedCount: 1, ...over })

  it('lists only the prerequisites with work left', () => {
    const list = [epic('a'), epic('b', { mergedCount: 2 }), epic('c')]
    expect(unfinishedPrerequisites({ dependsOn: ['a', 'b'] }, list).map(e => e.id)).toEqual(['a'])
  })

  it('counts a prerequisite with an unmerged epic PR', () => {
    const list = [epic('a', { reviewMode: 'epic', branch: 'b', mergedCount: 2, reviewState: 'human_review' })]
    expect(unfinishedPrerequisites({ dependsOn: ['a'] }, list).map(e => e.id)).toEqual(['a'])
  })
})

describe('matchesEpicFilter', () => {
  const epic = { id: 'e1', title: 'Billing export' }

  it('searches the title, ignoring case', () => {
    expect(matchesEpicFilter(epic, { search: 'BILLING', epics: [] })).toBe(true)
    expect(matchesEpicFilter(epic, { search: 'auth', epics: [] })).toBe(false)
  })

  it('applies the Epic filter', () => {
    expect(matchesEpicFilter(epic, { search: '', epics: ['e1'] })).toBe(true)
    expect(matchesEpicFilter(epic, { search: '', epics: ['e2'] })).toBe(false)
  })

  it('ignores the hidden filters when deciding whether anything is set', () => {
    const hidden: BoardFilters = { ...NO_FILTERS, statuses: ['ready'] }
    expect(hasEpicFilters(hidden)).toBe(false)
    expect(hasEpicFilters({ ...NO_FILTERS, epics: ['e1'] })).toBe(true)
  })
})

describe('epicWorkingAgents', () => {
  const agents = [{ id: 'a', name: 'Atlas' }, { id: 'b', name: 'Vera' }, { id: 'c', name: 'Tam' }] as import('@corral/contracts').Agent[]
  const task = (epicId: string, agentId: string | null) => ({ epicId, lease: agentId ? { agentId } : null }) as Pick<Task, 'epicId' | 'lease'>
  const run = (epicId: string, agentId: string, state = 'running') => ({ epicId, agentId, state }) as Pick<import('@corral/contracts').Run, 'epicId' | 'agentId' | 'state'>

  it('unions leases with taskless epic runs once per agent in stable order', () => {
    expect(epicWorkingAgents('epic', [task('epic', 'a'), task('epic', 'a'), task('other', 'c')], [run('epic', 'b'), run('epic', 'a'), run('other', 'c')], agents)).toEqual(agents.slice(0, 2))
  })

  it('includes every active state and excludes finished runs and unleased tasks', () => {
    for (const state of ['queued', 'starting', 'running', 'waiting_for_input', 'stopping']) {
      expect(epicWorkingAgents('epic', [], [run('epic', 'b', state)], agents)).toEqual([agents[1]])
    }
    expect(epicWorkingAgents('epic', [task('epic', null)], [run('epic', 'b', 'completed')], agents)).toEqual([])
  })
})
