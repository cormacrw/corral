import { describe, expect, it } from 'vitest'
import { BOARD_COLUMNS, MERGED_WINDOW_DAYS, onBoard, swipeStep } from './board.ts'

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
