// @vitest-environment happy-dom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { ref } from 'vue'

class FakeEventSource {
  static OPEN = 1
  static opened: FakeEventSource[] = []
  readyState = 1
  closed = false
  handlers = new Map<string, () => void>()
  onerror: (() => void) | null = null
  constructor() {
    FakeEventSource.opened.push(this)
  }

  addEventListener(type: string, handler: () => void) {
    this.handlers.set(type, handler)
  }

  close() {
    this.closed = true
  }
}

const hidden = (value: boolean) => {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(value ? 'hidden' : 'visible')
  document.dispatchEvent(new Event('visibilitychange'))
}
const current = () => FakeEventSource.opened.at(-1)!

async function connected() {
  vi.resetModules()
  const { STREAM_SILENCE_MS, subscribeReconnect, useLive } = await import('./useLive')
  const reconnected = vi.fn()
  subscribeReconnect(reconnected)
  useLive().connect()
  current().handlers.get('ready')!()
  return { reconnected, silence: STREAM_SILENCE_MS }
}

beforeEach(() => {
  vi.useFakeTimers()
  FakeEventSource.opened = []
  vi.stubGlobal('EventSource', FakeEventSource)
  vi.stubGlobal('useRoute', () => ({ params: {} }))
  vi.stubGlobal('usePendingPlan', () => ({ apply: () => {} }))
  const state = ref()
  vi.stubGlobal('useState', (_key: string, init: () => unknown) => {
    state.value ??= init()
    return state
  })
})
afterEach(() => {
  vi.useRealTimers()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
})

it('leaves a live stream alone on return, so nothing refetches', async () => {
  const { reconnected, silence } = await connected()
  hidden(true)
  vi.advanceTimersByTime(silence - 1000)
  current().handlers.get('ping')!()
  vi.advanceTimersByTime(silence - 1000)
  hidden(false)
  expect(FakeEventSource.opened).toHaveLength(1)
  expect(reconnected).not.toHaveBeenCalled()
})

it('reconnects a stream that went quiet while the phone slept, though it looks open', async () => {
  const { reconnected, silence } = await connected()
  const asleep = current()
  hidden(true)
  vi.advanceTimersByTime(silence + 1000)
  hidden(false)
  expect(asleep.closed).toBe(true)
  expect(FakeEventSource.opened).toHaveLength(2)
  current().handlers.get('ready')!()
  expect(reconnected).toHaveBeenCalledTimes(1)
})

it('reconnects at once on return rather than waiting out a retry', async () => {
  const { reconnected } = await connected()
  current().onerror!()
  expect(FakeEventSource.opened).toHaveLength(1)
  hidden(false)
  expect(FakeEventSource.opened).toHaveLength(2)
  current().handlers.get('ready')!()
  expect(reconnected).toHaveBeenCalledTimes(1)
  // The waiting retry is gone
  vi.advanceTimersByTime(60_000)
  expect(FakeEventSource.opened).toHaveLength(2)
})

it('does nothing while still hidden', async () => {
  const { silence } = await connected()
  vi.advanceTimersByTime(silence + 1000)
  hidden(true)
  expect(FakeEventSource.opened).toHaveLength(1)
})
