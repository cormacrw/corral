import { describe, expect, it } from 'vitest'
import type { Task } from '@corral/contracts'
import { backlogGroups, matchesBacklog, movableRows, moveGroupLabel, priorityText } from '~/features/board/utils/backlog.ts'

const task = (over: Record<string, unknown>) => ({ ref: 'COR-1', title: 'Add login', status: 'backlog', type: 'task', parentTask: null, epicId: null, mergedAt: null, updatedAt: '2026-01-01T00:00:00Z', priority: 'medium', ...over }) as unknown as Task

describe('matchesBacklog', () => {
  it('keeps Backlog tasks, and done ones only when asked', () => {
    const done = task({ status: 'merged' })
    expect(matchesBacklog(task({}), '', false)).toBe(true)
    expect(matchesBacklog(done, '', false)).toBe(false)
    expect(matchesBacklog(done, '', true)).toBe(true)
    expect(matchesBacklog(task({ status: 'ready' }), '', true)).toBe(false)
  })

  it('searches the ref and title, in any case', () => {
    expect(matchesBacklog(task({}), 'cor-1', false)).toBe(true)
    expect(matchesBacklog(task({}), 'LOGIN', false)).toBe(true)
    expect(matchesBacklog(task({}), 'billing', false)).toBe(false)
  })
})

describe('backlogGroups', () => {
  const own = task({ ref: 'COR-1' })
  const sub = task({ ref: 'COR-2', parentTask: 'COR-9', epicId: 'e1' })
  const merged = task({ ref: 'COR-3', parentTask: 'COR-9', epicId: 'e1', status: 'merged' })
  const epics = [{ id: 'e1', title: 'Billing' }]

  it('groups by parent and counts progress across the whole group', () => {
    expect(backlogGroups([own, sub, merged], [own, sub], epics)).toEqual([
      { id: 'none', title: 'On their own', rows: [own], merged: 0, total: 1 },
      { id: 'e1', title: 'Billing', rows: [sub], merged: 1, total: 2 }
    ])
  })

  it('drops a group with no row to show', () => {
    expect(backlogGroups([own, sub], [own], epics).map(g => g.id)).toEqual(['none'])
  })
})

describe('group actions', () => {
  it('moves only the rows still in the Backlog, and words the button for how many', () => {
    const one = { rows: [task({}), task({ status: 'merged' })] }
    expect(movableRows(one)).toHaveLength(1)
    expect(moveGroupLabel(one)).toBe('Move to board')
    expect(moveGroupLabel({ rows: [task({}), task({})] })).toBe('Move all to board')
  })
})

describe('priorityText', () => {
  it('colours urgent and high, and leaves the rest muted', () => {
    expect(priorityText({ priority: 'urgent' })).toBe('text-destructive')
    expect(priorityText({ priority: 'high' })).toBe('text-warning')
    expect(priorityText({ priority: 'low' })).toBe('text-muted-foreground')
  })
})
