import type { Run } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { busyShare, runBars, runTone, tokensByDay } from './fleet'

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
