import { describe, expect, it } from 'vitest'
import { runExitError, withLastActivity } from './run-exit.ts'

const at = '2026-10-30T11:02:55.000Z'

describe('runExitError', () => {
  it('gives the time limit', () => {
    expect(runExitError({ kind: 'timed_out', limitSeconds: 3600 }, at)).toBe(`The run hit its time limit of 60 minutes. Last transcript activity: ${at}`)
    expect(runExitError({ kind: 'timed_out', limitSeconds: 90 }, null)).toBe('The run hit its time limit of 90 seconds')
  })

  it('gives the server\'s stop reason', () => {
    expect(runExitError({ kind: 'stopped', reason: 'Lease expired' }, null)).toBe('Stopped by the server: Lease expired')
  })

  it('says the runner shut down', () => {
    expect(runExitError({ kind: 'runner_shutdown' }, at)).toContain('The runner shut down')
  })

  it('names a signal from outside Corral', () => {
    expect(runExitError({ kind: 'signalled', signal: 'SIGTERM' }, at)).toBe(`The agent was killed by SIGTERM, which came from outside Corral. Last transcript activity: ${at}`)
  })

  it('reads an exit from a runner that sends no details', () => {
    expect(runExitError({ kind: 'stopped' }, undefined)).toBe('Stopped')
    expect(runExitError({ kind: 'timed_out' }, undefined)).toBe('The run hit its time limit')
  })

  it('leaves an error alone with no activity to add', () => {
    expect(withLastActivity('Stopped by a human', null)).toBe('Stopped by a human')
  })
})
