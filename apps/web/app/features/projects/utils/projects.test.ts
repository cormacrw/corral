import type { TaskInboxItem, Inbox } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { projectCardSummary, projectNeedsYou } from '~/features/projects/utils/projects.ts'

const now = Date.parse('2026-10-29T12:00:00Z')
type Status = 'approved' | 'backlog' | 'ready' | 'in_progress' | 'agent_review' | 'human_review' | 'ready_to_merge' | 'blocked' | 'failed' | 'merged'
const task = (ref: string, status: Status, lease: 'developer' | 'reviewer' | null = null) => ({
  ref, status, type: status === 'approved' ? 'design' as const : 'task' as const, updatedAt: new Date(now).toISOString(), mergedAt: status === 'merged' ? new Date(now - 60 * 60 * 1000).toISOString() : null,
  lease: lease ? { agentId: lease === 'developer' ? 'bolt' : 'vera', runId: 'r', role: lease, expiresAt: '' } : null,
  developer: lease ? { id: 'bolt', name: 'Bolt' } : null,
  reviewer: lease === 'reviewer' ? { id: 'vera', name: 'Vera' } : null
})

describe('projectNeedsYou', () => {
  const blocked = { id: 'task', type: 'blocked', project: { id: 'p1' } } as unknown as TaskInboxItem
  const other = { ...blocked, id: 'other', project: { id: 'another-project' } } as TaskInboxItem
  const inbox = (needsYou: Inbox['needsYou']): Inbox => ({ needsYou, activity: [], resolved: [], count: 0 })

  it('counts the project\'s share of Needs you, so project counts add up to the global one', () => {
    const listed = inbox([blocked, other])
    expect(projectNeedsYou(listed, 'p1')).toEqual([blocked])
    expect(projectNeedsYou(listed, 'another-project')).toEqual([other])
  })

  it('counts nothing for a project with nothing waiting', () => {
    expect(projectNeedsYou(inbox([blocked]), 'empty-project')).toEqual([])
    expect(projectNeedsYou(null, 'p1')).toEqual([])
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
    expect(s.working).toEqual({ agent: 'Bolt', role: 'developer' })
    expect(s.line).toContain('COR-35')
  })

  it('mentions further leased tasks', () => {
    const one = projectCardSummary({ paused: false }, [task('COR-35', 'in_progress', 'developer')], 0, now)
    const two = projectCardSummary({ paused: false }, [task('COR-35', 'in_progress', 'developer'), task('COR-31', 'agent_review', 'reviewer')], 0, now)
    expect(two.working).toEqual(one.working)
    expect(two.line).not.toBe(one.line)
  })

  it('shows nobody working on a paused project, even with a lease', () => {
    expect(projectCardSummary({ paused: true }, [task('COR-35', 'in_progress', 'developer')], 0, now).working).toBeNull()
  })
})
