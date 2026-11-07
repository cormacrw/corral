import type { Run } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { busyShare, dayBars, dayLane, medianMinutesByDay, outcomesByDay, runBars, runTone, tokensByDay } from './fleet'

const HOUR = 3_600_000
const now = new Date(2026, 10, 4, 15, 0).getTime()
const ago = (hours: number) => new Date(now - hours * HOUR).toISOString()

const run = (extra: Partial<Run>): Run => ({
  id: 'r', number: 1, agentId: 'a1', agentName: 'Ash', agentRuntime: 'claude-code', role: 'developer',
  state: 'completed', outcome: 'pr_opened', queuedAt: ago(3), startedAt: ago(3), endedAt: ago(2),
  projectId: 'p', planSessionId: null, taskId: 't', taskRef: 'COR-1', taskTitle: 'Task', epicId: null, epicTitle: null,
  summary: null, error: null, headSha: null, inputTokens: 100, cacheReadTokens: 50, outputTokens: 10, cacheWriteTokens: 5,
  rateLimitResetAt: null, timings: null, runnerId: null, runnerName: null,
  ...extra
}) as Run

describe('runTone', () => {
  it('names live, rework and failure, and keeps rate limits quiet', () => {
    expect(runTone(run({ state: 'running', outcome: null, endedAt: null }))).toBe('live')
    expect(runTone(run({ role: 'reviewer', outcome: 'changes_requested' }))).toBe('changes')
    expect(runTone(run({ outcome: 'stuck' }))).toBe('failed')
    expect(runTone(run({ state: 'failed', outcome: null }))).toBe('failed')
    expect(runTone(run({ outcome: 'rate_limited' }))).toBe('quiet')
    expect(runTone(run({ state: 'interrupted', outcome: null }))).toBe('quiet')
    expect(runTone(run({}))).toBe('done')
    // A PM turn completes with nothing to report
    expect(runTone(run({ role: 'pm', state: 'completed', outcome: null }))).toBe('done')
  })
})

describe('runBars', () => {
  it('clips runs to the window, runs live ones to now and orders lanes by agent', () => {
    const bars = runBars([
      run({ id: 'old', startedAt: ago(20), endedAt: ago(14) }),
      run({ id: 'edge', startedAt: ago(14), endedAt: ago(11) }),
      run({ id: 'live', agentId: 'a2', agentName: 'Birch', state: 'running', outcome: null, startedAt: ago(1), endedAt: null }),
      run({ id: 'queued', startedAt: null, endedAt: null, state: 'queued', outcome: null })
    ], [{ id: 'a2', name: 'Birch' }, { id: 'a1', name: 'Ash' }], 12, now)
    expect(bars.map(b => [b.run.id, b.lane, b.x, b.hours])).toEqual([
      ['live', 'Birch', 11, 1],
      ['edge', 'Ash', 0, 1]
    ])
  })
})

describe('tokensByDay', () => {
  it('adds input, cache writes and output per role and day', () => {
    const days = tokensByDay([
      run({ queuedAt: ago(1) }),
      run({ role: 'reviewer', queuedAt: ago(1) }),
      run({ queuedAt: ago(24) })
    ], 2, now)
    expect(days[1]!.byRole).toEqual({ developer: 115, reviewer: 115, pm: 0, designer: 0 })
    expect(days[0]!.byRole.developer).toBe(115)
  })
})

describe('busyShare', () => {
  it('is running time over the window and the agent’s slots', () => {
    const runs = [run({ startedAt: ago(4), endedAt: ago(1) }), run({ startedAt: ago(14), endedAt: ago(10) })]
    expect(busyShare(runs, { id: 'a1', role: 'developer', concurrency: 1 }, 12, now)).toBeCloseTo(5 / 12)
    expect(busyShare(runs, { id: 'a1', role: 'developer', concurrency: 2 }, 12, now)).toBeCloseTo(5 / 24)
    expect(busyShare(runs, { id: 'other', role: 'developer', concurrency: 1 }, 12, now)).toBe(0)
  })
})

describe('dayBars', () => {
  it('gives each day with runs a lane, today first, with x the hour of day', () => {
    const at = (daysAgo: number, hour: number) => new Date(2026, 10, 4 - daysAgo, hour).toISOString()
    const bars = dayBars([
      run({ id: 'today', startedAt: at(0, 9), endedAt: at(0, 10) }),
      run({ id: 'late', startedAt: at(2, 23), endedAt: at(1, 1) }),
      run({ id: 'yesterday', startedAt: at(1, 6), endedAt: at(1, 7) }),
      run({ id: 'live', state: 'running', outcome: null, startedAt: at(0, 14), endedAt: null }),
      run({ id: 'old', startedAt: at(7, 9), endedAt: at(7, 10) }),
      run({ id: 'queued', state: 'queued', outcome: null, startedAt: null, endedAt: null })
    ], 7, now)
    expect(bars.map(b => [b.run.id, b.lane, b.x, b.hours])).toEqual([
      ['today', 'Today', 9, 1],
      ['live', 'Today', 14, 1],
      ['yesterday', 'Yesterday', 6, 1],
      // Clipped at the end of the day it started; days 3–6 had no runs, so no lanes
      ['late', dayLane(2, new Date(2026, 10, 2)), 23, 1]
    ])
    expect(dayLane(2, new Date(2026, 10, 2))).toMatch(/^2 \S+$/)
  })
})

describe('outcomesByDay', () => {
  it('counts ended runs per day by how they ended, leaving out live ones', () => {
    const days = outcomesByDay([
      run({ queuedAt: ago(1) }),
      run({ role: 'pm', outcome: null, queuedAt: ago(1) }),
      run({ outcome: 'changes_requested', queuedAt: ago(1) }),
      run({ outcome: 'stuck', queuedAt: ago(1) }),
      run({ state: 'interrupted', outcome: null, queuedAt: ago(1) }),
      run({ state: 'running', outcome: null, endedAt: null, queuedAt: ago(1) }),
      run({ outcome: 'rate_limited', queuedAt: ago(24) })
    ], 14, now)
    expect(days).toHaveLength(14)
    expect(days[13]).toMatchObject({ byTone: { done: 2, changes: 1, failed: 1, quiet: 1 }, total: 5 })
    expect(days[12]).toMatchObject({ byTone: { done: 0, changes: 0, failed: 0, quiet: 1 }, total: 1 })
    expect(days[0]!.total).toBe(0)
  })
})

describe('medianMinutesByDay', () => {
  it('is the median length of each day’s ended runs, and null for a day with none', () => {
    const lengths = medianMinutesByDay([
      run({ queuedAt: ago(5), startedAt: ago(5), endedAt: new Date(now - 5 * HOUR + 10 * 60_000).toISOString() }),
      run({ queuedAt: ago(5), startedAt: ago(5), endedAt: new Date(now - 5 * HOUR + 30 * 60_000).toISOString() }),
      run({ queuedAt: ago(48), startedAt: ago(48), endedAt: ago(47) }),
      run({ queuedAt: ago(24), startedAt: ago(24), endedAt: null, state: 'running', outcome: null })
    ], 3, now)
    expect(lengths).toEqual([60, null, 20])
  })
})
