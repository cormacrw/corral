import { describe, expect, it } from 'vitest'
import { auditEvent, auditText, readAudit, type AuditEvent, type TransitionDetail } from './audit.ts'

describe('audit writes', () => {
  it('builds an entry from an action and its detail', () => {
    expect(auditEvent('task.created', { number: 3 })).toEqual({ action: 'task.created', detail: { number: 3 } })
  })

  // Checked by tsc: each directive fails the typecheck if the line compiles
  it('ties detail keys to the action', () => {
    // @ts-expect-error missing key
    auditEvent('task.created', {})
    // @ts-expect-error wrongly named key
    auditEvent('task.created', { num: 3 })
    // @ts-expect-error extra key
    auditEvent('run.stopped', { runId: 'r', reason: 'x' })
    // @ts-expect-error wrong value type
    auditEvent('task.created', { number: '3' })
    // @ts-expect-error unknown action
    auditEvent('task.renamed', {})
    // @ts-expect-error a detail-free action takes no keys
    auditEvent('task.resumed', { runId: 'r' })
    // @ts-expect-error an action picked at runtime can't use either side's detail
    auditEvent(Date.now() > 0 ? 'task.created' : 'task.resumed', {})
    // @ts-expect-error a transition needs its status change
    auditEvent('task.transition', { event: 'pr_closed' })
    // @ts-expect-error an event's own keys are required
    auditEvent('task.transition', { event: 'stuck', from: 'in_progress', to: 'blocked' })
    // @ts-expect-error unknown transition event
    auditEvent('task.transition', { event: 'pr_renamed', from: 'in_progress', to: 'blocked' })
    // @ts-expect-error a built entry can't be assembled with another action's detail
    const entry: AuditEvent = { action: 'task.created', detail: { runId: 'r' } }
    // @ts-expect-error wrongly named key for a transition's event
    const detail: TransitionDetail = { event: 'ci_failed', check: [] }
    // @ts-expect-error only keys the action stores can be queried
    auditText('task.transition', 'target')
    expect([entry, detail]).toHaveLength(2)
  })
})

describe('readAudit', () => {
  it('reads a string event', () => {
    expect(readAudit({ event: 'resolve', from: 'blocked', to: 'ready' })).toMatchObject({ event: 'resolve', to: 'ready' })
  })

  it('reads an object event', () => {
    expect(readAudit({ event: { type: 'resolve', to: 'ready' }, from: 'blocked', to: 'ready' })).toMatchObject({ event: 'resolve', to: 'ready' })
  })

  it('takes the target from inside an object event', () => {
    expect(readAudit({ event: { type: 'resolve', to: 'backlog' } })).toMatchObject({ event: 'resolve', to: 'backlog' })
  })

  it('reads rows with no event', () => {
    expect(readAudit({ verdict: 'approved', met: 2, of: 3 })).toEqual({ event: null, to: null, verdict: 'approved', met: 2, of: 3 })
    expect(readAudit({ event: null })).toMatchObject({ event: null, to: null })
    expect(readAudit(undefined)).toEqual({ event: null, to: null })
  })
})
