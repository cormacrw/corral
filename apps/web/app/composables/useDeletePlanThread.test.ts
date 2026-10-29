// @vitest-environment happy-dom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { PlanThreadItem } from '@corral/contracts'

const mocks = vi.hoisted(() => ({ close: vi.fn(), add: vi.fn(), removeToast: vi.fn(), removeThread: vi.fn(), refresh: vi.fn() }))
vi.mock('~/composables/useApi', () => ({ api: { plan: { close: mocks.close } } }))

const item = { id: 's-5', sessionId: 's-5', type: 'plan_thread', subject: 'Flaky CI' } as PlanThreadItem
type Toast = { id: string, duration: number, actions: { label: string, onClick: () => void }[] }

describe('deleting a Plan thread with Undo', () => {
  let use: typeof import('./useDeletePlanThread')

  beforeEach(async () => {
    vi.resetModules()
    vi.resetAllMocks()
    vi.useFakeTimers()
    vi.stubGlobal('ref', ref)
    vi.stubGlobal('useToast', () => ({ add: mocks.add, remove: mocks.removeToast }))
    vi.stubGlobal('usePlanThreads', () => ({ remove: mocks.removeThread }))
    mocks.close.mockResolvedValue({})
    mocks.refresh.mockResolvedValue(undefined)
    use = await import('./useDeletePlanThread')
  })
  afterEach(() => {
    vi.useRealTimers()
  })
  const toast = () => mocks.add.mock.calls[0]![0] as Toast

  it('hides the thread at once and closes it only after five seconds', async () => {
    const d = use.useDeletePlanThread(mocks.refresh)
    d.remove(item)
    expect(d.hidden('s-5')).toBe(true)
    expect(toast()).toMatchObject({ title: 'Thread deleted', duration: 5000 })
    expect(toast().actions.map(a => a.label)).toEqual(['Undo'])
    await vi.advanceTimersByTimeAsync(4999)
    expect(mocks.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(1)
    expect(mocks.close).toHaveBeenCalledWith('s-5')
    expect(mocks.removeThread).toHaveBeenCalledWith('s-5')
    // Shown again only once the reloaded list no longer has it
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(d.hidden('s-5')).toBe(false)
  })

  it('Undo restores the thread and never closes the session', async () => {
    const d = use.useDeletePlanThread(mocks.refresh)
    d.remove(item)
    toast().actions[0]!.onClick()
    expect(d.hidden('s-5')).toBe(false)
    expect(mocks.removeToast).toHaveBeenCalledWith(toast().id)
    await vi.advanceTimersByTimeAsync(10_000)
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('outlives the screen it started on', async () => {
    use.useDeletePlanThread(mocks.refresh)
    use.useDeletePlanThread().remove(item)
    expect(use.useDeletePlanThread().hidden('s-5')).toBe(true)
    await vi.advanceTimersByTimeAsync(5000)
    expect(mocks.close).toHaveBeenCalledWith('s-5')
    expect(mocks.refresh).toHaveBeenCalledOnce()
  })

  it('shows the thread again with an error when closing fails', async () => {
    mocks.close.mockRejectedValue(new Error('Runner offline'))
    const d = use.useDeletePlanThread(mocks.refresh)
    d.remove(item)
    await vi.advanceTimersByTimeAsync(5000)
    expect(d.hidden('s-5')).toBe(false)
    expect(mocks.removeThread).not.toHaveBeenCalled()
    expect(mocks.add).toHaveBeenLastCalledWith(expect.objectContaining({ title: 'Couldn\'t delete the thread', description: 'Runner offline', color: 'error' }))
  })
})
