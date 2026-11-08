import { describe, expect, it } from 'vitest'
import { TASK_STATUSES } from '@corral/core'
import { homeColumn, IN_PROGRESS_STAGES, liveRunTitle } from '~/features/home/utils/figures'
import { sameDay } from '~/utils/days'

describe('IN_PROGRESS_STAGES', () => {
  it('gives every in-progress Board column its own stage, so open work adds up', () => {
    expect([...IN_PROGRESS_STAGES]).toEqual(TASK_STATUSES.filter(s => homeColumn(s) === 'in_progress'))
  })
})

describe('sameDay', () => {
  const now = new Date(2026, 9, 29, 15, 0)
  it('compares local calendar days', () => {
    expect(sameDay(new Date(2026, 9, 29, 0, 0).toISOString(), now)).toBe(true)
    expect(sameDay(new Date(2026, 9, 30, 0, 0).toISOString(), now)).toBe(false)
    expect(sameDay(null, now)).toBe(false)
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

  it('names the Plan session of a PM turn', () => {
    expect(liveRunTitle(run, 'Search filters')).toContain('Search filters')
  })

  it('never gives another role the PM\'s fallback title', () => {
    expect(liveRunTitle({ ...run, role: 'reviewer' }, null)).not.toBe(liveRunTitle(run, null))
  })
})
