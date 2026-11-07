// @vitest-environment happy-dom
import { defineComponent, h, ref } from 'vue'
import { flushPromises, mount } from '@vue/test-utils'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { testQueryClient } from '~/queries/mount-with-query'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { useAgentActivity } from './useAgentActivity'

const mocks = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('~/composables/useApi', () => ({ api: { runs: { list: mocks.list } } }))

describe('useAgentActivity', () => {
  const wrappers: ReturnType<typeof mount>[] = []
  afterEach(() => {
    wrappers.splice(0).forEach(w => w.unmount())
    vi.resetAllMocks()
  })
  function activity(agentId: () => string | null, alsoRetry?: () => Promise<unknown>) {
    let result!: ReturnType<typeof useAgentActivity>
    wrappers.push(mount(defineComponent({ setup() {
      result = useAgentActivity(agentId, alsoRetry)
      return () => h('div')
    } }), { global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]] } }))
    return result
  }

  it('asks for this agent’s runs since local midnight 13 days ago', async () => {
    mocks.list.mockResolvedValue([])
    const id = ref<string | null>(null)
    const a = activity(() => id.value)
    await flushPromises()
    // Nothing to ask for until the agent is known
    expect(mocks.list).not.toHaveBeenCalled()
    id.value = 'a1'
    await flushPromises()
    const midnight = new Date()
    midnight.setHours(0, 0, 0, 0)
    midnight.setDate(midnight.getDate() - 13)
    expect(mocks.list).toHaveBeenCalledWith({ agentId: 'a1', since: midnight.toISOString() })
    expect(a.loading.value).toBe(false)
  })

  it('retries its own query together with the page’s runs', async () => {
    mocks.list.mockRejectedValueOnce(new Error('Server error')).mockResolvedValue([])
    const reloadRuns = vi.fn().mockResolvedValue(undefined)
    const a = activity(() => 'a1', reloadRuns)
    await flushPromises()
    expect(a.error.value).toBe('Server error')
    await a.retry()
    expect(reloadRuns).toHaveBeenCalledOnce()
    expect(mocks.list).toHaveBeenCalledTimes(2)
    expect(a.error.value).toBeNull()
  })
})
