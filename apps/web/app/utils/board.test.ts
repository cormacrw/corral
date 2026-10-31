import { describe, expect, it } from 'vitest'
import { BOARD_COLUMNS, cardAssignee, filterLabel, filtersFromQuery, filtersToQuery, hasFilters, matchesFilter, MERGED_WINDOW_DAYS, NO_FILTERS, onBoard, sortColumn, swipeStep, taskAgentIds } from './board.ts'

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
