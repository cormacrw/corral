import { describe, expect, it } from 'vitest'
import { runComposer } from './run-composer'

const claude = { name: 'Victor', runtime: 'claude-code' as const }
const codex = { name: 'Dana', runtime: 'codex' as const }

describe('runComposer', () => {
  it('opens on a live Claude developer or reviewer run', () => {
    expect(runComposer({ state: 'running', role: 'developer' }, claude, true)).toEqual({ kind: 'open' })
    expect(runComposer({ state: 'waiting_for_input', role: 'reviewer' }, claude, true)).toEqual({ kind: 'open' })
    expect(runComposer({ state: 'starting', role: 'developer' }, claude, true)).toEqual({ kind: 'open' })
  })

  it('keeps finished runs read-only', () => {
    for (const state of ['completed', 'failed', 'interrupted'] as const) {
      expect(runComposer({ state, role: 'developer' }, claude, true)).toEqual({ kind: 'read-only' })
      expect(runComposer({ state, role: 'developer' }, codex, true)).toEqual({ kind: 'read-only' })
    }
  })

  it('disables the composer on a Codex run and says why', () => {
    const composer = runComposer({ state: 'running', role: 'developer' }, codex, true)
    expect(composer.kind).toBe('disabled')
    expect(composer.kind === 'disabled' && composer.reason).toBe('Codex can\'t take messages mid-run. Comment on the task and Dana reads it on its next run.')
  })

  it('sends a PM turn to Plan', () => {
    expect(runComposer({ state: 'running', role: 'pm' }, claude, true)).toEqual({ kind: 'plan' })
  })

  it('disables the composer when the message has nowhere to go', () => {
    expect(runComposer({ state: 'queued', role: 'developer' }, claude, true).kind).toBe('disabled')
    expect(runComposer({ state: 'stopping', role: 'developer' }, claude, true).kind).toBe('disabled')
    expect(runComposer({ state: 'running', role: 'developer' }, claude, false).kind).toBe('disabled')
  })
})
