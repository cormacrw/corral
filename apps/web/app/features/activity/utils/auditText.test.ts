import type { AuditEntry } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { historyText } from '~/features/activity/utils/auditText'

const entry = (action: string, detail: Record<string, unknown> = {}) => ({ id: 1, action, detail, createdAt: '2026-01-01T00:00:00Z', actor: { kind: 'agent', role: 'pm', runId: 'r1' } }) as unknown as AuditEntry

describe('historyText', () => {
  it('words a PM pause and resume', () => {
    expect(historyText(entry('task.paused'))).toBe('paused the task')
    expect(historyText(entry('task.resumed'))).toBe('resumed the task')
  })

  it('falls back to the raw action for one it does not know', () => {
    expect(historyText(entry('task.unknown'))).toBe('task.unknown')
  })
})
