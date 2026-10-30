// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ close: vi.fn(), add: vi.fn(), removeToast: vi.fn(), removeThread: vi.fn(), refresh: vi.fn() }))
vi.mock('~/composables/useApi', () => ({ api: { plan: { close: mocks.close } } }))

type Toast = { id: string, duration: number, actions: { label: string, onClick: () => void }[] }

describe('deleting a Plan thread with Undo', () => {
  const listeners: EventListenerOrEventListenerObject[] = []
  let use: typeof import('./usePlanThreadDelete')

  beforeEach(async () => {
    vi.resetAllMocks()
    const add = window.addEventListener.bind(window)
    vi.spyOn(window, 'addEventListener').mockImplementation((type, listener, options) => {
      if (String(type) === 'pagehide') listeners.push(listener)
      add(type, listener, options)
    })
    vi.resetModules()
    vi.useFakeTimers()
    vi.stubGlobal('useToast', () => ({ add: mocks.add, remove: mocks.removeToast }))
    vi.stubGlobal('usePlanThreads', () => ({ remove: mocks.removeThread }))
    mocks.add.mockReturnValue({ id: 'toast-1' })
    mocks.close.mockResolvedValue({})
    mocks.refresh.mockResolvedValue(undefined)
    use = await import('./usePlanThreadDelete')
  })
  afterEach(() => {
    for (const listener of listeners.splice(0)) window.removeEventListener('pagehide', listener)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  const toast = () => mocks.add.mock.calls[0]![0] as Toast

  it('hides the thread at once and closes it only after five seconds', async () => {
    const d = use.usePlanThreadDelete()
    d.remove('s-5', mocks.refresh)
    expect(d.pending.value.includes('s-5')).toBe(true)
    expect(toast()).toMatchObject({ title: 'Thread deleted · its drafts were discarded', duration: 5000 })
    expect(toast().actions.map(a => a.label)).toEqual(['Undo'])
    await vi.advanceTimersByTimeAsync(4999)
    expect(mocks.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.close).toHaveBeenCalledWith('s-5')
    expect(mocks.removeThread).toHaveBeenCalledWith('s-5')
    // Shown again only once the reloaded list no longer has it
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(d.pending.value.includes('s-5')).toBe(false)
  })

  it('Undo restores the thread and never closes the session', async () => {
    const d = use.usePlanThreadDelete()
    d.remove('s-5', mocks.refresh)
    toast().actions[0]!.onClick()
    expect(d.pending.value.includes('s-5')).toBe(false)
    expect(mocks.removeToast).toHaveBeenCalledWith('toast-1')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('outlives the screen it started on', async () => {
    use.usePlanThreadDelete()
    use.usePlanThreadDelete().remove('s-5', mocks.refresh)
    expect(use.usePlanThreadDelete().pending.value.includes('s-5')).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.close).toHaveBeenCalledWith('s-5')
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('flushes a pending mobile delete on pagehide with keepalive', async () => {
    const mobile = use.usePlanThreadDelete()
    mobile.remove('s-5', mocks.refresh)
    expect(use.usePlanThreadDelete().pending.value).toContain('s-5')
    window.dispatchEvent(new Event('pagehide'))
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith('s-5', { keepalive: true })
    expect(mocks.removeThread).toHaveBeenCalledWith('s-5')
    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('shows the thread again with an error when closing fails', async () => {
    mocks.close.mockRejectedValue(new Error('Runner offline'))
    const d = use.usePlanThreadDelete()
    d.remove('s-5', mocks.refresh)
    await vi.advanceTimersByTimeAsync(5000)
    expect(d.pending.value.includes('s-5')).toBe(false)
    expect(mocks.removeThread).not.toHaveBeenCalled()
    expect(mocks.add).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Could not delete the thread', description: 'Runner offline', color: 'error' }))
  })
})
