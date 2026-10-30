import type { Agent, DesignVersion, Run } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { agentFacts, agentLimit, designerStats, groupAgents, todayStats } from './agents.ts'

const agent = (id: string, activeRuns = 0): Agent => ({
  id, name: id, role: 'developer', runtime: 'claude', concurrency: 1, paused: false, wakeIntervalSeconds: null, pausedUntil: null, activeRuns, avatarUrl: null
})
const run = (id: string, agentId: string, state: Run['state'], queuedAt = '2026-10-29T10:00:00Z', tokens = 0): Run => ({
  id, runnerId: null, runnerName: null, number: 1, agentId, agentName: agentId, role: 'developer', projectId: 'p', planSessionId: null, taskId: null, taskRef: null, taskTitle: null,
  outcome: null, summary: null, error: null, headSha: null, inputTokens: tokens, cacheReadTokens: null, outputTokens: 0, rateLimitResetAt: null,
  timings: null, queuedAt, startedAt: queuedAt, ...(state === 'completed' || state === 'failed' || state === 'interrupted' ? { state, endedAt: queuedAt } : { state, endedAt: null })
})

describe('groupAgents', () => {
  it('puts working agents first with their live run', () => {
    const runs = [run('r3', 'atlas', 'running'), run('r2', 'atlas', 'completed'), run('r1', 'vera', 'completed')]
    const { working, idle } = groupAgents([agent('juno'), agent('atlas', 1), agent('vera')], runs)
    expect(working.map(r => [r.agent.id, r.run?.id])).toEqual([['atlas', 'r3']])
    expect(idle.map(r => [r.agent.id, r.run?.id ?? null])).toEqual([['juno', null], ['vera', 'r1']])
  })

  it('shows a working agent whose run has not loaded yet without one', () => {
    expect(groupAgents([agent('atlas', 1)], []).working).toEqual([{ agent: agent('atlas', 1), run: null }])
  })
})

describe('todayStats', () => {
  it('counts only today', () => {
    const now = new Date('2026-10-29T15:00:00Z').getTime()
    const runs = [run('a', 'x', 'completed', '2026-10-29T12:00:00Z', 1200), run('b', 'x', 'completed', '2026-10-20T12:00:00Z', 500)]
    const tasks = [{ mergedAt: '2026-10-29T13:00:00Z' }, { mergedAt: null }, { mergedAt: '2026-10-01T13:00:00Z' }]
    expect(todayStats(runs, tasks, now)).toEqual({ runs: 1, merged: 1, tokens: 1200 })
  })
})

describe('agentFacts', () => {
  it('says one turn per session for the PM, with no concurrency', () => {
    const pm = { role: 'pm' as const, concurrency: 3 }
    expect(agentLimit(pm)).toBe('one turn per session')
    expect(agentFacts(pm)).toBe('One turn per session · a read-only checkout of the default branch · .corral/agents/pm.md')
    expect(agentFacts(pm)).not.toMatch(/concurrency|3/i)
  })

  it('shows the concurrency for developers and reviewers', () => {
    expect(agentLimit({ role: 'developer', concurrency: 2 })).toBe('concurrency 2')
    expect(agentFacts({ role: 'developer', concurrency: 2 })).toBe('Concurrency 2 · one worktree per task · .corral/agents/developer.md')
    expect(agentFacts({ role: 'reviewer', concurrency: 1 })).toBe('Concurrency 1 · a read-only task worktree · .corral/agents/reviewer.md')
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
