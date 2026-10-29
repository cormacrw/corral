import { describe, expect, it } from 'vitest'
import { BOARD_COLUMNS, epicFilterLabel, matchesFilter, MERGED_WINDOW_DAYS, onBoard, sortColumn, swipeStep } from './board.ts'

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
    expect(statuses.sort()).toEqual(['agent_review', 'blocked', 'failed', 'human_review', 'in_progress', 'merged', 'ready', 'ready_to_merge'])
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
    { ref: 'TA-1', title: 'Login form', epicId: 'auth' },
    { ref: 'TA-2', title: 'Logout button', epicId: 'auth' },
    { ref: 'TA-3', title: 'Billing page', epicId: 'billing' },
    { ref: 'TA-4', title: 'Login audit log', epicId: 'audit' },
    { ref: 'TA-5', title: 'Loose task', epicId: null }
  ]
  const refs = (epics: string[], search = '') => tasks.filter(t => matchesFilter(t, epics, search)).map(t => t.ref)

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
})

describe('epicFilterLabel', () => {
  const names: Record<string, string> = { auth: 'Auth', billing: 'Billing' }
  const label = (id: string) => names[id]!

  it('reads All epics, the epic name, or N epics', () => {
    expect(epicFilterLabel([], label)).toBe('All epics')
    expect(epicFilterLabel(['billing'], label)).toBe('Billing')
    expect(epicFilterLabel(['auth', 'billing'], label)).toBe('2 epics')
  })
})
