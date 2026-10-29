import { describe, expect, it } from 'vitest'
import { projectCardSummary } from './projects.ts'

const now = Date.parse('2026-10-29T12:00:00Z')
const agents = [{ name: 'Atlas', role: 'developer' as const }, { name: 'Vera', role: 'reviewer' as const }]
const task = (ref: string, status: 'backlog' | 'ready' | 'in_progress' | 'agent_review' | 'merged', lease: 'developer' | 'reviewer' | null = null) => ({
  ref, status, mergedAt: status === 'merged' ? new Date(now - 1000).toISOString() : null,
  lease: lease ? { runId: 'r', role: lease, expiresAt: '' } : null
})

describe('projectCardSummary', () => {
  it('counts board and backlog tasks', () => {
    const s = projectCardSummary({ paused: false }, [task('A-1', 'backlog'), task('A-2', 'backlog'), task('A-3', 'ready'), task('A-4', 'merged')], agents, 0, now)
    expect(s.board).toBe(2)
    expect(s.backlog).toBe(2)
  })

  it('names the agent working on a task', () => {
    const s = projectCardSummary({ paused: false }, [task('COR-35', 'in_progress', 'developer')], agents, 0, now)
    expect(s.line).toBe('Atlas building COR-35')
    expect(s.working).toEqual({ agent: 'Atlas', role: 'developer' })
  })

  it('counts further leased tasks', () => {
    const s = projectCardSummary({ paused: false }, [task('COR-35', 'in_progress', 'developer'), task('COR-31', 'agent_review', 'reviewer')], agents, 0, now)
    expect(s.line).toBe('Atlas building COR-35 and 1 more')
  })

  it('explains a paused project with what needs you', () => {
    expect(projectCardSummary({ paused: true }, [], agents, 1, now).line).toBe('No new runs start while paused. 1 needs you.')
    expect(projectCardSummary({ paused: true }, [], agents, 0, now).line).toBe('No new runs start while paused.')
  })

  it('falls back to what needs you, then to nothing running', () => {
    expect(projectCardSummary({ paused: false }, [], agents, 2, now).line).toBe('2 needs you.')
    expect(projectCardSummary({ paused: false }, [], agents, 0, now).line).toBe('Nothing running.')
  })
})
