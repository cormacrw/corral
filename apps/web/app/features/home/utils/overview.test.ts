import type { Epic } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { formatDuration, mergedByDay, openWork, recentEpics, startOfDay, weekOverWeek } from './overview'

const now = new Date(2026, 10, 4, 15, 0).getTime()
const daysAgo = (n: number, hour = 12) => new Date(2026, 10, 4 - n, hour).toISOString()
const merged = (n: number, extra = {}) => ({ type: 'task' as const, status: 'merged' as const, mergedAt: daysAgo(n), updatedAt: daysAgo(n), ...extra })

describe('mergedByDay', () => {
  it('counts merges per local day and project, today last', () => {
    const rows = mergedByDay([{ id: 'a' }, { id: 'b' }], {
      a: [merged(0), merged(0, { mergedAt: daysAgo(0, 1) }), merged(2), merged(30)],
      b: [merged(2), { type: 'task', status: 'in_progress', mergedAt: null, updatedAt: daysAgo(0) }]
    }, 3, now)
    expect(rows.map(r => r.total)).toEqual([2, 0, 2])
    expect(rows[0]!.byProject).toEqual({ a: 1, b: 1 })
    expect(rows[2]!.byProject).toEqual({ a: 2, b: 0 })
    expect(rows[2]!.date.getTime()).toBe(startOfDay(now))
  })

  it('counts an approved design on its approval', () => {
    const rows = mergedByDay([{ id: 'a' }], { a: [{ type: 'design', status: 'approved', mergedAt: null, updatedAt: daysAgo(1) }] }, 2, now)
    expect(rows.map(r => r.total)).toEqual([1, 0])
  })
})

describe('weekOverWeek', () => {
  it('splits 14 days into this week and the one before', () => {
    const rows = Array.from({ length: 14 }, (_, i) => ({ total: i < 7 ? 1 : 2 }))
    expect(weekOverWeek(rows)).toEqual({ thisWeek: 14, lastWeek: 7 })
  })
})

describe('openWork', () => {
  it('counts Ready and the working statuses, not Backlog or Done', () => {
    const [row] = openWork([{ id: 'a' }], { a: [{ status: 'ready' }, { status: 'in_progress' }, { status: 'human_review' }, { status: 'backlog' }, { status: 'merged' }] })
    expect(row!.total).toBe(3)
    expect(row!.stages).toEqual({ ready: 1, in_progress: 1, agent_review: 0, human_review: 1, ready_to_merge: 0 })
  })
})

describe('recentEpics', () => {
  const epic = (id: string, updatedAt: string, extra: Partial<Epic> = {}) => ({ id, taskId: `t-${id}`, branch: null, updatedAt, taskCount: 0, mergedCount: 0, ...extra }) as Epic
  it('lists real parents newest first, with live counts, up to the limit', () => {
    const result = recentEpics([{ id: 'a' }, { id: 'b' }], {
      a: [epic('old', daysAgo(5)), epic('collapsed', daysAgo(0), { taskId: null })],
      b: [epic('new', daysAgo(1)), epic('mid', daysAgo(3))]
    }, { b: [{ epicId: 'new', status: 'merged', type: 'task' }, { epicId: 'new', status: 'ready', type: 'task' }] }, 2)
    expect(result.map(r => r.epic.id)).toEqual(['new', 'mid'])
    expect(result[0]!.epic).toMatchObject({ taskCount: 2, mergedCount: 1 })
    expect(result[0]!.project).toEqual({ id: 'b' })
  })
})

describe('formatDuration', () => {
  it('reads as minutes, hours or days', () => {
    expect(formatDuration(20 * 60_000)).toBe('20m')
    expect(formatDuration(5.94 * 3_600_000)).toBe('5.9h')
    expect(formatDuration(14.5 * 3_600_000)).toBe('15h')
    expect(formatDuration(72 * 3_600_000)).toBe('3.0d')
  })
})
