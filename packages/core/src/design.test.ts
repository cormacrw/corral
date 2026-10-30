import { describe, expect, it } from 'vitest'
import { approveDesignVersion, isDesignPinStale, nextDesignVersion, STALE_PIN_STATUSES, type DesignVersionState } from './design.ts'
import type { DesignPinTarget } from './plan.ts'
import { TASK_STATUSES } from './status.ts'
import { requiresHumanReview, TASK_TYPES } from './task.ts'

const versions = (...statuses: DesignVersionState['status'][]): (DesignVersionState & { id: string })[] =>
  statuses.map((status, i) => ({ id: `v${i + 1}`, version: i + 1, status }))

describe('approveDesignVersion (D20)', () => {
  it('marks the version approved and every earlier version superseded', () => {
    const result = approveDesignVersion(versions('changes_requested', 'changes_requested', 'submitted'), 3)
    expect(result).toEqual({
      ok: true,
      versions: [
        { id: 'v1', version: 1, status: 'superseded' },
        { id: 'v2', version: 2, status: 'superseded' },
        { id: 'v3', version: 3, status: 'approved' }
      ]
    })
  })

  it('supersedes an earlier approved version when a newer one is approved', () => {
    const result = approveDesignVersion(versions('superseded', 'approved', 'submitted'), 3)
    expect(result.ok && result.versions.map(v => v.status)).toEqual(['superseded', 'superseded', 'approved'])
  })

  it('leaves later versions alone', () => {
    const result = approveDesignVersion(versions('submitted', 'submitted'), 1)
    expect(result.ok && result.versions.map(v => v.status)).toEqual(['approved', 'submitted'])
  })

  it('works whatever order the versions come in', () => {
    const shuffled = [...versions('submitted', 'changes_requested', 'submitted')].reverse()
    const result = approveDesignVersion(shuffled, 2)
    expect(result.ok && result.versions.map(v => [v.version, v.status])).toEqual([[3, 'submitted'], [2, 'approved'], [1, 'superseded']])
  })

  it('rejects a version that does not exist', () => {
    expect(approveDesignVersion(versions('submitted'), 2)).toEqual({ ok: false, error: 'Design version v2 doesn\'t exist' })
  })

  it('rejects a superseded version', () => {
    expect(approveDesignVersion(versions('superseded', 'approved'), 1).ok).toBe(false)
  })
})

describe('nextDesignVersion', () => {
  it('numbers versions 1..n per task', () => {
    expect(nextDesignVersion([])).toBe(1)
    expect(nextDesignVersion(versions('superseded', 'approved'))).toBe(3)
  })
})

describe('design task type (D20)', () => {
  it('is a task type', () => {
    expect(TASK_TYPES).toContain('design')
  })

  it('always requires human review', () => {
    expect(requiresHumanReview('design', false)).toBe(true)
    expect(requiresHumanReview('design', true)).toBe(true)
    expect(requiresHumanReview('task', false)).toBe(false)
    expect(requiresHumanReview('bug', true)).toBe(true)
  })
})

describe('isDesignPinStale (D20)', () => {
  const pinnedToV1 = { version: 1, latestApproved: 2 }

  it('flags Draft, Backlog and Ready tasks pinned to an older version than the approved one', () => {
    for (const status of STALE_PIN_STATUSES) expect(isDesignPinStale(pinnedToV1, { status, started: false })).toBe(true)
  })

  it('leaves tasks that have started alone, whatever their status', () => {
    for (const status of TASK_STATUSES.filter(s => !STALE_PIN_STATUSES.some(stale => stale === s))) {
      expect(isDesignPinStale(pinnedToV1, { status, started: true })).toBe(false)
      expect(isDesignPinStale(pinnedToV1, { status, started: false })).toBe(false)
    }
    expect(isDesignPinStale(pinnedToV1, { status: 'ready', started: true })).toBe(false)
  })

  it('does not flag a pin to the approved version', () => {
    expect(isDesignPinStale({ version: 2, latestApproved: 2 }, { status: 'ready', started: false })).toBe(false)
    expect(isDesignPinStale({ version: 2, latestApproved: null }, { status: 'ready', started: false })).toBe(false)
  })
})

describe('design version statuses', () => {
  it('rejects a misspelled status at compile time', () => {
    // @ts-expect-error 'apprvoed' is not a DesignVersionStatus
    const target: DesignPinTarget = { kind: 'version', status: 'apprvoed' }
    // @ts-expect-error 'apprvoed' is not a DesignVersionStatus
    const version: DesignVersionState = { version: 1, status: 'apprvoed' }
    expect([target, version]).toHaveLength(2)
  })
})
