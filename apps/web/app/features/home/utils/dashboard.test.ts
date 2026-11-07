import { describe, expect, it } from 'vitest'
import { liveRunTitle } from '~/features/home/utils/dashboard.ts'

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
