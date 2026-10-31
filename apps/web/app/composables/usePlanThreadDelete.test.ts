// @vitest-environment happy-dom
import { defineComponent, h } from 'vue'
import { mount } from '@vue/test-utils'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { testQueryClient } from '~/queries/mount-with-query'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({ close: vi.fn(), add: vi.fn(), removeToast: vi.fn(), removeThread: vi.fn() }))
vi.mock('~/composables/useApi', () => ({ api: { plan: { close: mocks.close } } }))

type Toast = { id: string, duration: number, actions: { label: string, onClick: () => void }[] }

describe('deleting a Plan thread with Undo', () => {
  const wrappers: ReturnType<typeof mount>[] = []
  function deletion() {
    let result!: ReturnType<typeof use.usePlanThreadDelete>
    wrappers.push(mount(defineComponent({ setup() {
      result = use.usePlanThreadDelete()
      return () => h('div')
    } }), { global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]] } }))
    return result
  }
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
    use = await import('./usePlanThreadDelete')
  })
  afterEach(() => {
    wrappers.splice(0).forEach(w => w.unmount())
    for (const listener of listeners.splice(0)) window.removeEventListener('pagehide', listener)
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.useRealTimers()
  })
  const toast = () => mocks.add.mock.calls[0]![0] as Toast

  it('hides the thread at once and closes it only after five seconds', async () => {
    const d = deletion()
    d.remove('s-5')
    expect(d.pending.value.includes('s-5')).toBe(true)
    expect(toast()).toMatchObject({ title: 'Thread deleted · its drafts were discarded', duration: 5000 })
    expect(toast().actions.map(a => a.label)).toEqual(['Undo'])
    await vi.advanceTimersByTimeAsync(4999)
    expect(mocks.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.close).toHaveBeenCalledWith('s-5')
    expect(mocks.removeThread).toHaveBeenCalledWith('s-5')
    expect(d.pending.value.includes('s-5')).toBe(false)
  })

  it('Undo restores the thread and never closes the session', async () => {
    const d = deletion()
    d.remove('s-5')
    toast().actions[0]!.onClick()
    expect(d.pending.value.includes('s-5')).toBe(false)
    expect(mocks.removeToast).toHaveBeenCalledWith('toast-1')
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('outlives the screen it started on', async () => {
    deletion()
    deletion().remove('s-5')
    expect(deletion().pending.value.includes('s-5')).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.close).toHaveBeenCalledWith('s-5')
  })

  it('flushes a pending mobile delete on pagehide with keepalive', async () => {
    const mobile = deletion()
    mobile.remove('s-5')
    expect(deletion().pending.value).toContain('s-5')
    window.dispatchEvent(new Event('pagehide'))
    expect(mocks.close).toHaveBeenCalledExactlyOnceWith('s-5', { keepalive: true })
    expect(mocks.removeThread).toHaveBeenCalledWith('s-5')
    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.close).toHaveBeenCalledOnce()
  })

  it('shows the thread again with an error when closing fails', async () => {
    mocks.close.mockRejectedValue(new Error('Runner offline'))
    const d = deletion()
    d.remove('s-5')
    await vi.advanceTimersByTimeAsync(5000)
    expect(d.pending.value.includes('s-5')).toBe(false)
    expect(mocks.removeThread).not.toHaveBeenCalled()
    expect(mocks.add).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Could not delete the thread', description: 'Runner offline', color: 'error' }))
  })
})
