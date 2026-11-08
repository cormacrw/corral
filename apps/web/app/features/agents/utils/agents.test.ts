import type { DesignVersion, Run } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { agentFacts, agentLimit, designerStats, todayStats } from '~/features/agents/utils/agents.ts'

const run = (id: string, agentId: string, state: Run['state'], queuedAt = '2026-10-29T10:00:00Z', tokens = 0): Run => ({
  id, runnerId: null, runnerName: null, number: 1, agentId, agentName: agentId, agentRuntime: 'claude-code', role: 'developer', projectId: 'p', planSessionId: null, taskId: null, taskRef: null, taskTitle: null, epicId: null, epicTitle: null,
  outcome: null, summary: null, error: null, headSha: null, inputTokens: tokens, cacheReadTokens: null, outputTokens: 0, rateLimitResetAt: null,
  timings: null, queuedAt, startedAt: queuedAt, ...(state === 'completed' || state === 'failed' || state === 'interrupted' ? { state, endedAt: queuedAt } : { state, endedAt: null })
})

describe('todayStats', () => {
  it('counts only today, in local time', () => {
    const at = (day: number, hour: number) => new Date(2026, 9, day, hour).toISOString()
    const now = new Date(2026, 9, 29, 15).getTime()
    const runs = [run('a', 'x', 'completed', at(29, 0), 1200), run('b', 'x', 'completed', at(28, 23), 500)]
    expect(todayStats(runs, now)).toEqual({ runs: 1, tokens: 1200 })
    expect(todayStats([{ ...runs[0]!, inputTokens: 10, cacheWriteTokens: 20, outputTokens: 5 }], now).tokens).toBe(35)
  })
})

describe('agentFacts', () => {
  it('shows a concurrency for developers but never for the PM (D13)', () => {
    const pm = { role: 'pm' as const, concurrency: 3 }
    expect(agentLimit(pm)).not.toMatch(/3/)
    expect(agentFacts(pm)).not.toMatch(/concurrency|3/i)
    expect(agentLimit({ role: 'developer', concurrency: 2 })).toMatch(/2/)
  })
})

describe('designerStats', () => {
  it('counts versions by author commit and approved tasks once, including superseded approvals', () => {
    const own = { ...run('design', 'iris', 'completed'), role: 'designer', taskId: 'task', headSha: 'own' } as Run
    const review = { ...run('review', 'iris', 'completed'), role: 'reviewer', taskId: 'task', headSha: 'other' } as Run
    const version = (id: string, commitSha: string, status: DesignVersion['status'], planSessionId: string | null = null): DesignVersion => ({
      id, version: 1, commitSha, status, planSessionId, branch: 'design/COR-1', spec: '', screenshots: [], previewUrl: '', feedback: null, createdAt: '2026-10-29T12:00:00Z'
    })
    expect(designerStats([own, own, review], [{ taskId: 'task', versions: [
      version('one', 'own', 'superseded', 'plan'), version('two', 'own', 'approved'), version('other', 'other', 'approved')
    ] }])).toEqual({ submitted: 2, approved: 1 })
    expect(designerStats([review], [{ taskId: 'task', versions: [version('other', 'other', 'approved')] }])).toEqual({ submitted: 0, approved: 0 })
  })
})
