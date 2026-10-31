import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope } from 'vue'
import { NOW_TICK_MS, useNow } from './useNow'

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers()
  })
  afterEach(() => {
    vi.useRealTimers()
  })

  it('shares one timer between readers and stops with the last of them', () => {
    const first = effectScope()
    const second = effectScope()
    const now = first.run(() => useNow())!
    second.run(() => useNow())
    expect(vi.getTimerCount()).toBe(1)

    const before = now.value
    vi.advanceTimersByTime(NOW_TICK_MS)
    expect(now.value).toBe(before + NOW_TICK_MS)

    first.stop()
    expect(vi.getTimerCount()).toBe(1)
    second.stop()
    expect(vi.getTimerCount()).toBe(0)
  })
})
