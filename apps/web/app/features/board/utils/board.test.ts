import { describe, expect, it } from 'vitest'
import type { Task } from '@corral/contracts'
import { activeFilterCount, boardFilterGroups, matchesOverviewEpicFilter, BOARD_COLUMNS, cardAssignee, boardMove, boardColumnKey, boardView, epicOnBoard, epicStage, epicWorkingAgents, filterLabel, filtersFromQuery, filtersToQuery, hasFilters, matchesEpicFilter, matchesFilter, COMPLETE_WINDOW_DAYS, NO_FILTERS, onBoard, sortColumn, swipeStep, taskAgentIds, unfinishedPrerequisites, columnEntries, matchesParentFilter } from '~/features/board/utils/board.ts'

const DAY = 24 * 60 * 60 * 1000
const now = Date.parse('2026-10-29T12:00:00Z')
const mergedAgo = (ms: number) => ({ type: 'task' as const, updatedAt: '', status: 'merged' as const, mergedAt: new Date(now - ms).toISOString() })

describe('onBoard', () => {
  it('keeps a task merged just inside the window and drops one just outside', () => {
    const window = COMPLETE_WINDOW_DAYS * DAY
    expect(onBoard(mergedAgo(window - 1000), now)).toBe(true)
    expect(onBoard(mergedAgo(window), now)).toBe(true)
    expect(onBoard(mergedAgo(window + 1000), now)).toBe(false)
  })

  it('hides merged tasks with no merge time', () => {
    expect(onBoard({ type: 'task', updatedAt: '', status: 'merged', mergedAt: null }, now)).toBe(false)
  })

  it('leaves other statuses alone and keeps Backlog off the board', () => {
    expect(onBoard({ type: 'task', updatedAt: '', status: 'ready', mergedAt: null }, now)).toBe(true)
    expect(onBoard({ type: 'task', updatedAt: '', status: 'blocked', mergedAt: null }, now)).toBe(true)
    expect(onBoard({ type: 'task', updatedAt: '', status: 'backlog', mergedAt: null }, now)).toBe(false)
    expect(onBoard({ type: 'task', updatedAt: '', status: 'draft', mergedAt: null }, now)).toBe(false)
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
  const task = (ref: string, mergedAt: string | null) => ({ ref, mergedAt, type: 'task' as const, status: 'merged' as const, updatedAt: '' })
  const refs = (tasks: { ref: string }[]) => tasks.map(t => t.ref)

  it('lists merged tasks newest first', () => {
    const tasks = [
      task('COR-1', '2026-10-27T09:00:00Z'),
      task('COR-2', '2026-10-29T09:00:00Z'),
      task('COR-3', '2026-10-28T09:00:00Z')
    ]
    expect(refs(sortColumn('complete', tasks))).toEqual(['COR-2', 'COR-3', 'COR-1'])
  })

  it('puts tasks with no merge time last', () => {
    const tasks = [task('COR-1', null), task('COR-2', '2026-10-27T09:00:00Z'), task('COR-3', null), task('COR-4', '2026-10-28T09:00:00Z')]
    expect(refs(sortColumn('complete', tasks))).toEqual(['COR-4', 'COR-2', 'COR-1', 'COR-3'])
  })

  it('breaks ties by ref, whatever order they came in', () => {
    const at = '2026-10-28T09:00:00Z'
    const expected = ['COR-2', 'COR-10', 'COR-11']
    expect(refs(sortColumn('complete', [task('COR-11', at), task('COR-2', at), task('COR-10', at)]))).toEqual(expected)
    expect(refs(sortColumn('complete', [task('COR-10', at), task('COR-11', at), task('COR-2', at)]))).toEqual(expected)
  })

  it('does not change the input', () => {
    const tasks = [task('COR-1', '2026-10-27T09:00:00Z'), task('COR-2', '2026-10-29T09:00:00Z')]
    sortColumn('complete', tasks)
    expect(refs(tasks)).toEqual(['COR-1', 'COR-2'])
  })

  it('leaves other columns in the order they came', () => {
    const tasks = [task('COR-3', '2026-10-27T09:00:00Z'), task('COR-1', null), task('COR-2', '2026-10-29T09:00:00Z')]
    for (const column of BOARD_COLUMNS.filter(c => c.key !== 'complete')) {
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
    expect(match({ statuses: ['ready', 'complete'] })).toEqual(['TA-1', 'TA-5'])
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

describe('cardAssignee', () => {
  const developer = { id: 'd', name: 'Dana' }
  const reviewer = { id: 'r', name: 'Rita' }

  it('shows the reviewer in Agent review and the developer otherwise', () => {
    expect(cardAssignee({ status: 'agent_review', developer, reviewer })).toBe(reviewer)
    for (const status of ['ready', 'in_progress', 'human_review', 'blocked', 'merged'] as const) {
      expect(cardAssignee({ status, developer, reviewer })).toBe(developer)
    }
  })

  it('never falls back to the other role', () => {
    expect(cardAssignee({ status: 'agent_review', developer, reviewer: null })).toBeNull()
    expect(cardAssignee({ status: 'in_progress', developer: null, reviewer })).toBeNull()
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
    const cleared = filtersToQuery(NO_FILTERS, { column: 'ready', status: 'ready' })
    expect(cleared.column).toBe('ready')
    expect(filtersFromQuery(cleared)).toEqual(NO_FILTERS)
    expect(filtersFromQuery({ status: 'nope,complete', priority: 'huge,low' })).toEqual({ ...NO_FILTERS, statuses: ['complete'], priorities: ['low'] })
  })

  it('maps saved merged and approved filters to the Complete column once', () => {
    expect(filtersFromQuery({ status: 'merged' }).statuses).toEqual(['complete'])
    expect(filtersFromQuery({ status: 'approved' }).statuses).toEqual(['complete'])
    expect(filtersFromQuery({ status: 'merged,ready,approved,complete' }).statuses).toEqual(['complete', 'ready'])
  })

  it('knows when anything is filtered', () => {
    expect(hasFilters(NO_FILTERS)).toBe(false)
    expect(hasFilters({ ...NO_FILTERS, agents: ['a1'] })).toBe(true)
    expect(hasFilters({ ...NO_FILTERS, search: 'x' })).toBe(true)
  })

  it('offers each filter the options it matches on', () => {
    const groups = boardFilterGroups([{ id: 'e1', label: 'Auth' }], [{ id: 'a1', name: 'Atlas' }])
    const values = (key: string) => groups.find(g => g.key === key)?.items.map(i => i.value)
    expect(values('epics')).toEqual(['e1'])
    expect(values('statuses')).toEqual(BOARD_COLUMNS.map(c => c.key))
    expect(values('agents')).toEqual(['a1'])
  })

  it('counts the filters that are set, not their items or the search', () => {
    expect(activeFilterCount({ ...NO_FILTERS, search: 'x' })).toBe(0)
    expect(activeFilterCount({ ...NO_FILTERS, agents: ['a1', 'a2'], priorities: ['high'] })).toBe(2)
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

describe('completed designs', () => {
  const design = (days: number) => ({ type: 'design' as const, status: 'approved' as const, mergedAt: null, updatedAt: new Date(now - days * DAY).toISOString(), ref: 'TA-10' })

  it('windows approvals and removes reopened designs from Complete', () => {
    expect(onBoard(design(2), now)).toBe(true)
    expect(onBoard(design(4), now)).toBe(false)
    expect(onBoard({ ...design(4), status: 'in_progress' }, now)).toBe(true)
    expect(matchesFilter({ ...design(1), title: '', epicId: null, priority: 'medium' }, { ...NO_FILTERS, statuses: ['complete'] })).toBe(true)
    expect(matchesFilter({ ...design(1), status: 'in_progress', title: '', epicId: null, priority: 'medium' }, { ...NO_FILTERS, statuses: ['complete'] })).toBe(false)
  })

  it('sorts approvals among merges by finish time', () => {
    expect(sortColumn('complete', [{ ...mergedAgo(DAY), ref: 'TA-1' }, design(0), design(2)]).map(t => t.ref)).toEqual(['TA-10', 'TA-1', 'TA-10'])
  })

  it('combines finished statuses in one column and preserves saved column links', () => {
    expect(boardColumnKey('merged')).toBe('complete')
    expect(boardColumnKey('approved')).toBe('complete')
    expect(boardColumnKey('ready')).toBe('ready')
  })
})

describe('columnEntries', () => {
  const finished = (ref: string, mergedAt: string) => ({ ref, type: 'task', status: 'merged', mergedAt, updatedAt: mergedAt }) as Task
  const card = (mergedAt: string) => ({ epic: { mergedAt, createdAt: '2020-01-01T00:00:00Z' } })

  it('lists Complete by when each finished, parents and tasks together', () => {
    const { entries } = columnEntries('complete', [finished('T-1', '2026-01-03T00:00:00Z'), finished('T-2', '2026-01-01T00:00:00Z')], [card('2026-01-02T00:00:00Z')])
    expect(entries.map(e => e.task?.ref ?? 'parent')).toEqual(['T-1', 'parent', 'T-2'])
  })

  it('leads other columns with their parents', () => {
    expect(columnEntries('ready', [finished('T-1', '2026-01-03T00:00:00Z')], [card('2026-01-02T00:00:00Z')]).entries.map(e => e.task?.ref ?? 'parent')).toEqual(['parent', 'T-1'])
  })
})

describe('matchesParentFilter', () => {
  it('applies priority and agent filters to a card', () => {
    const none = { priorities: [], agents: [] }
    expect(matchesParentFilter({ workingAgents: [] }, undefined, none)).toBe(true)
    expect(matchesParentFilter({ workingAgents: [] }, { priority: 'low' }, { ...none, priorities: ['high'] })).toBe(false)
    expect(matchesParentFilter({ workingAgents: [{ id: 'a' }] }, { priority: 'high' }, { priorities: ['high'], agents: ['a'] })).toBe(true)
    expect(matchesParentFilter({ workingAgents: [] }, { priority: 'high' }, { ...none, agents: ['a'] })).toBe(false)
  })
})

describe('boardView', () => {
  it('lets the URL win over the view last used', () => {
    expect(boardView('top', 'all')).toBe('top')
    expect(boardView('all', 'top')).toBe('all')
    expect(boardView(['top', 'all'], 'all')).toBe('top')
  })

  it('reads saved links from before parent tasks', () => {
    expect(boardView('epics', 'all')).toBe('top')
    expect(boardView('tasks', 'top')).toBe('all')
  })

  it('falls back when the URL has no valid view', () => {
    expect(boardView(undefined, 'top')).toBe('top')
    expect(boardView('nonsense', 'all')).toBe('all')
  })
})

describe('epicStage', () => {
  const epic = (over: Partial<Parameters<typeof epicStage>[0]> = {}) => ({
    reviewMode: 'epic' as const, branch: 'corral/epic', reviewState: null, taskCount: 2, mergedCount: 1, ...over
  })
  const merged = [{ status: 'merged' as const }, { status: 'merged' as const }]
  const allMerged = { mergedCount: 2 }

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
    reviewMode: 'epic' as const, branch: 'corral/epic', reviewState: null, taskCount: 1, mergedCount: 1, mergedAt: null, updatedAt: new Date(now - 10 * DAY).toISOString(), ...over
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
    expect(epicOnBoard(epic({ ...merged, mergedAt: new Date(now - DAY).toISOString() }), [old], now)).toBe(true)
    expect(epicOnBoard(epic(merged), [old], now)).toBe(false)
  })

  it('keeps a finished epic in Done for the window after a design is approved', () => {
    const direct = epic({ reviewMode: 'direct', branch: null })
    const approvedAgo = (ms: number) => ({ type: 'design' as const, status: 'approved' as const, mergedAt: null, updatedAt: new Date(now - ms).toISOString() })
    expect(epicStage(direct, [approvedAgo(DAY)])).toBe('done')
    expect(epicOnBoard(direct, [approvedAgo(DAY)], now)).toBe(true)
    expect(epicOnBoard(direct, [old, approvedAgo(DAY)], now)).toBe(true)
    expect(epicOnBoard(direct, [approvedAgo(4 * DAY)], now)).toBe(false)
  })

  it('does not let an unfinished task hold a finished epic on the Board', () => {
    const direct = epic({ reviewMode: 'direct', branch: null })
    const reopened = { type: 'task' as const, status: 'in_progress' as const, mergedAt: null, updatedAt: new Date(now).toISOString() }
    expect(epicOnBoard(direct, [old, reopened], now)).toBe(false)
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

describe('overview epic filters', () => {
  const epic = { reviewMode: 'direct' as const, branch: null, reviewState: null, taskCount: 1, mergedCount: 0 }
  const matches = (status: Task['status'], counts = epic) => ['open', 'in-progress', 'closed'].map(filter => matchesOverviewEpicFilter(counts, [{ status }], filter as 'open' | 'in-progress' | 'closed'))

  it.each(['draft', 'backlog', 'ready'] as const)('keeps %s only in Open', (status) => {
    expect(matches(status)).toEqual([true, false, false])
  })
  it.each(['in_progress', 'blocked', 'failed', 'agent_review', 'human_review', 'ready_to_merge'] as const)('keeps %s in Open and In Progress', (status) => {
    expect(matches(status)).toEqual([true, true, false])
  })
  it('closes once every task has merged, with live counts', () => {
    expect(matches('merged', { ...epic, mergedCount: 1 })).toEqual([false, false, true])
  })
  it('keeps empty epics open and unstarted', () => {
    expect(matchesOverviewEpicFilter({ ...epic, taskCount: 0 }, [], 'open')).toBe(true)
    expect(matchesOverviewEpicFilter({ ...epic, taskCount: 0 }, [], 'in-progress')).toBe(false)
    expect(matchesOverviewEpicFilter({ ...epic, taskCount: 0 }, [], 'closed')).toBe(false)
  })
  it.each(['open', 'in_review', 'human_review', 'ready_to_merge', 'conflict', 'merged'] as const)('uses the done stage for epic PR state %s', (reviewState) => {
    const reviewing = { ...epic, reviewMode: 'epic' as const, reviewState, mergedCount: 1 }
    const tasks = [{ status: 'merged' as const }]
    const done = epicStage(reviewing, tasks) === 'done'
    expect(matchesOverviewEpicFilter(reviewing, tasks, 'closed')).toBe(done)
    expect(matchesOverviewEpicFilter(reviewing, tasks, 'open')).toBe(!done)
    expect(matchesOverviewEpicFilter(reviewing, tasks, 'in-progress')).toBe(!done)
  })
})
