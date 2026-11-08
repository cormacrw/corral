import type { AuditEntry } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { historyText } from '~/features/activity/utils/auditText'

const entry = (action: string, detail: Record<string, unknown> = {}) => ({ id: 1, action, detail, createdAt: '2026-01-01T00:00:00Z', actor: { kind: 'agent', role: 'pm', runId: 'r1' } }) as unknown as AuditEntry

describe('historyText', () => {
  it('names the reviewed commit by short SHA, but not a findings review', () => {
    const sha = 'abcdef1234567890'
    expect(historyText(entry('review.recorded', { verdict: 'approved', met: 2, of: 2, headSha: sha }))).toContain('abcdef1234')
    expect(historyText(entry('review.recorded', { verdict: 'approved', met: 2, of: 2, headSha: sha }))).not.toContain(sha)
    expect(historyText(entry('review.recorded', { verdict: 'approved', met: 2, of: 2, headSha: 'findings-r1' }))).not.toContain('findings-r1')
  })

  it('falls back to the raw action for one it does not know', () => {
    expect(historyText(entry('task.unknown'))).toBe('task.unknown')
  })
})
