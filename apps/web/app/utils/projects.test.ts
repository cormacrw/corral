import type { Inbox } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { releaseNotes } from '../prototype/fixtures.ts'
import { projectCardSummary, projectNeedsYou } from './projects.ts'

const now = Date.parse('2026-10-29T12:00:00Z')
type Status = 'approved' | 'backlog' | 'ready' | 'in_progress' | 'agent_review' | 'human_review' | 'ready_to_merge' | 'blocked' | 'failed' | 'merged'
const task = (ref: string, status: Status, lease: 'developer' | 'reviewer' | null = null) => ({
  ref, status, mergedAt: status === 'merged' ? new Date(now - 60 * 60 * 1000).toISOString() : null,
  lease: lease ? { agentId: lease === 'developer' ? 'bolt' : 'vera', runId: 'r', role: lease, expiresAt: '' } : null,
  developer: lease ? { id: 'bolt', name: 'Bolt' } : null,
  reviewer: lease === 'reviewer' ? { id: 'vera', name: 'Vera' } : null
})

describe('projectNeedsYou', () => {
  const notes = releaseNotes[0]!
  const blocked = { ...notes, id: 'task', type: 'blocked' } as unknown as Inbox['needsYou'][number]
  const inbox = (needsYou: Inbox['needsYou']): Inbox => ({ needsYou, activity: [], resolved: [], count: 0 })

  it('leaves release notes out of the count, however many there are', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({ ...notes, id: `release-${i}` }))
    expect(projectNeedsYou(inbox(many), notes.project.id)).toEqual([])
    expect(projectNeedsYou(inbox([...many, blocked]), notes.project.id)).toEqual([blocked])
    expect(projectCardSummary({ paused: false }, [], projectNeedsYou(inbox(many), notes.project.id).length, now).line).toBe('Nothing running.')
  })

  it('counts only the given project', () => {
    expect(projectNeedsYou(inbox([blocked]), 'another-project')).toEqual([])
    expect(projectNeedsYou(null, notes.project.id)).toEqual([])
  })
})

describe('projectCardSummary', () => {
  it('counts board and backlog tasks', () => {
    const s = projectCardSummary({ paused: false }, [task('A-1', 'backlog'), task('A-2', 'backlog'), task('A-3', 'ready'), task('A-4', 'merged'), task('A-5', 'approved')], 0, now)
    expect(s.board).toBe(1)
    expect(s.backlog).toBe(2)
  })

  it('leaves recently merged tasks out of the board count', () => {
    expect(projectCardSummary({ paused: false }, [task('A-1', 'ready'), task('A-2', 'ready'), task('A-3', 'merged')], 0, now).board).toBe(2)
    expect(projectCardSummary({ paused: false }, [task('A-1', 'backlog'), task('A-2', 'merged'), task('A-3', 'merged')], 0, now).board).toBe(0)
  })

  it('counts every in-flight status toward the board', () => {
    const statuses: Status[] = ['ready', 'in_progress', 'agent_review', 'human_review', 'ready_to_merge', 'blocked', 'failed']
    expect(projectCardSummary({ paused: false }, statuses.map((s, i) => task(`A-${i}`, s)), 0, now).board).toBe(statuses.length)
  })

  it('names the agent of the task\'s run, not the first of its role', () => {
    const s = projectCardSummary({ paused: false }, [task('COR-35', 'in_progress', 'developer')], 0, now)
    expect(s.line).toBe('Bolt building COR-35')
    expect(s.working).toEqual({ agent: 'Bolt', role: 'developer' })
  })

  it('counts further leased tasks', () => {
    const s = projectCardSummary({ paused: false }, [task('COR-35', 'in_progress', 'developer'), task('COR-31', 'agent_review', 'reviewer')], 0, now)
    expect(s.line).toBe('Bolt building COR-35 and 1 more')
  })

  it('explains a paused project with what needs you', () => {
    expect(projectCardSummary({ paused: true }, [], 1, now).line).toBe('No new runs start while paused. 1 needs you.')
    expect(projectCardSummary({ paused: true }, [], 0, now).line).toBe('No new runs start while paused.')
  })

  it('falls back to what needs you, then to nothing running', () => {
    expect(projectCardSummary({ paused: false }, [], 2, now).line).toBe('2 needs you.')
    expect(projectCardSummary({ paused: false }, [], 0, now).line).toBe('Nothing running.')
  })
})
