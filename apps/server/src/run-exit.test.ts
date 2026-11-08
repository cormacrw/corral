import { describe, expect, it } from 'vitest'
import { runExitError } from './run-exit.ts'
import { withLastActivity } from './run-stops.ts'

const at = '2026-10-30T11:02:55.000Z'

describe('runExitError', () => {
  it('gives the time limit in minutes or seconds, with the last activity when known', () => {
    const hour = runExitError({ kind: 'timed_out', limitSeconds: 3600 }, at)
    expect(hour).toContain('60 minutes')
    expect(hour).toContain(at)
    const short = runExitError({ kind: 'timed_out', limitSeconds: 90 }, null)
    expect(short).toContain('90 seconds')
    expect(short).not.toContain('activity')
  })

  it('gives the server\'s stop reason', () => {
    expect(runExitError({ kind: 'stopped', reason: 'Lease expired' }, null)).toContain('Lease expired')
  })

  it('names a signal from outside Corral', () => {
    const error = runExitError({ kind: 'signalled', signal: 'SIGTERM' }, at)
    expect(error).toContain('SIGTERM')
    expect(error).toContain(at)
  })

  it('reads an exit from a runner that sends no details', () => {
    for (const exit of [{ kind: 'stopped' }, { kind: 'timed_out' }] as const) {
      const error = runExitError(exit, undefined)
      expect(error).not.toMatch(/undefined|null|:/)
    }
  })

  it('leaves an error alone with no activity to add', () => {
    expect(withLastActivity('Stopped by a human', null)).toBe('Stopped by a human')
  })
})
