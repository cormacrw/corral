import { describe, expect, it } from 'vitest'
import type { TaskStatus, TaskType } from '@corral/core'
import { dashboardCounts, elapsed, isToday, liveRunTitle } from './dashboard.ts'

const now = new Date(2026, 9, 29, 15, 0)
const task = (status: TaskStatus, extra: { mergedAt?: string | null, reviewRounds?: number, type?: TaskType, updatedAt?: string } = {}) => ({ status, type: 'task' as const, updatedAt: '', mergedAt: null, reviewRounds: 0, ...extra })

describe('dashboardCounts', () => {
  it('counts Ready as to do and the four working stages as in progress', () => {
    const counts = dashboardCounts([
      task('backlog'), task('ready'), task('ready'),
      task('in_progress'), task('in_progress'), task('agent_review'), task('human_review'), task('ready_to_merge')
    ], now)
    expect(counts.todo).toBe(2)
    expect(counts.inProgress).toBe(5)
    expect(counts.stages).toEqual({ in_progress: 2, agent_review: 1, human_review: 1, ready_to_merge: 1 })
    expect(counts.waitingForReview).toBe(1)
  })

  it('counts blocked and failed together, outside in progress', () => {
    const counts = dashboardCounts([task('blocked'), task('failed'), task('in_progress')], now)
    expect(counts.blocked).toBe(2)
    expect(counts.inProgress).toBe(1)
  })

  it('counts merges from today only, and the first-pass ones among them', () => {
    const today = new Date(2026, 9, 29, 9, 30).toISOString()
    const yesterday = new Date(2026, 9, 28, 23, 59).toISOString()
    const counts = dashboardCounts([
      task('merged', { mergedAt: today }),
      task('merged', { mergedAt: today, reviewRounds: 2 }),
      task('merged', { mergedAt: yesterday }),
      task('merged', { mergedAt: null }),
      task('approved', { type: 'design', updatedAt: today }),
      task('approved', { type: 'design', updatedAt: yesterday }),
      task('in_progress', { type: 'design', updatedAt: today })
    ], now)
    expect(counts.mergedToday).toBe(3)
    expect(counts.firstPassToday).toBe(2)
  })

  it('is all zeros with no tasks', () => {
    expect(dashboardCounts([], now)).toMatchObject({ todo: 0, inProgress: 0, blocked: 0, waitingForReview: 0, mergedToday: 0, firstPassToday: 0 })
  })
})

describe('isToday', () => {
  it('compares local calendar days', () => {
    expect(isToday(new Date(2026, 9, 29, 0, 0).toISOString(), now)).toBe(true)
    expect(isToday(new Date(2026, 9, 30, 0, 0).toISOString(), now)).toBe(false)
    expect(isToday(null, now)).toBe(false)
  })
})

describe('elapsed', () => {
  const at = now.getTime()
  it('shows seconds, minutes, then hours and minutes', () => {
    expect(elapsed(new Date(at - 45_000).toISOString(), at)).toBe('45s')
    expect(elapsed(new Date(at - 18 * 60_000).toISOString(), at)).toBe('18m')
    expect(elapsed(new Date(at - 125 * 60_000).toISOString(), at)).toBe('2h 5m')
    expect(elapsed(null, at)).toBe('')
  })
})

describe('liveRunTitle', () => {
  const run = { taskTitle: null, epicTitle: null, summary: null, role: 'pm' as const }

  it('names the epic of a live epic review instead of Planning', () => {
    expect(liveRunTitle({ ...run, role: 'reviewer', epicTitle: 'Saved searches' }, null)).toBe('Saved searches')
  })

  it('names the task of a task run', () => {
    expect(liveRunTitle({ ...run, role: 'developer', taskTitle: 'Prototype build' }, null)).toBe('Prototype build')
  })

  it('keeps Planning and the Plan session for PM turns', () => {
    expect(liveRunTitle(run, 'Search filters')).toBe('Answering in Search filters')
    expect(liveRunTitle(run, null)).toBe('Planning')
  })

  it('never calls another role Planning', () => {
    expect(liveRunTitle({ ...run, role: 'reviewer' }, null)).toBe('Run')
  })
})
