// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { useQuery, VueQueryPlugin } from '@tanstack/vue-query'
import { computed, defineComponent, h, onBeforeUnmount, ref, watch } from 'vue'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'

interface TestAgent { id: string, name: string, concurrency: number, activeRuns: number }

const client = testQueryClient()
const agent = () => client.getQueryData<TestAgent[]>(keys.agents.list())![0]!
const seed = (patch: Partial<TestAgent> = {}) => client.setQueryData<TestAgent[]>(keys.agents.list(), [{ id: 'a1', name: 'Victor', concurrency: 2, activeRuns: 0, ...patch }])

// Nuxt auto-imports the stepper uses
const toast = { add: vi.fn() }
vi.stubGlobal('computed', computed)
vi.stubGlobal('ref', ref)
vi.stubGlobal('watch', watch)
vi.stubGlobal('onBeforeUnmount', onBeforeUnmount)
vi.stubGlobal('useToast', () => toast)

const { default: ConcurrencyStepper } = await import('./ConcurrencyStepper.vue')

const UButton = defineComponent({
  props: ['disabled'],
  emits: ['click'],
  setup: (props, { emit, attrs }) => () => h('button', { 'disabled': props.disabled, 'aria-label': attrs['aria-label'], 'class': attrs.class, 'onClick': () => emit('click') })
})

// The parent passes the live agent, so optimistic updates reach the prop
function mountStepper() {
  const Parent = defineComponent({ setup() {
    const agents = useQuery<TestAgent[]>({ queryKey: keys.agents.list(), enabled: false })
    return () => h(ConcurrencyStepper, { agent: agents.data.value![0]! })
  } })
  return mount(Parent, { global: { components: { UButton }, plugins: [[VueQueryPlugin, { queryClient: client }]] } })
}

const fetchMock = vi.fn()
beforeEach(() => {
  vi.useFakeTimers()
  vi.stubGlobal('fetch', fetchMock)
  seed()
})
afterEach(() => {
  vi.useRealTimers()
  fetchMock.mockReset()
  toast.add.mockReset()
})

const ok = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
const number = (wrapper: ReturnType<typeof mountStepper>) => wrapper.get('[data-testid="concurrency"]').text()
const plus = (wrapper: ReturnType<typeof mountStepper>) => wrapper.get('[aria-label="Increase concurrency for Victor"]')
const minus = (wrapper: ReturnType<typeof mountStepper>) => wrapper.get('[aria-label="Decrease concurrency for Victor"]')

describe('ConcurrencyStepper', () => {
  it('shows each tap at once and sends quick taps as one PATCH', async () => {
    fetchMock.mockResolvedValue(ok({ ...agent(), concurrency: 5 }))
    const wrapper = mountStepper()
    const seen: string[] = []
    for (let i = 0; i < 3; i++) {
      await plus(wrapper).trigger('click')
      seen.push(number(wrapper))
      vi.advanceTimersByTime(200)
    }
    expect(seen).toEqual(['3', '4', '5'])
    expect(agent().concurrency).toBe(5)
    expect(fetchMock).not.toHaveBeenCalled()
    vi.advanceTimersByTime(600)
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    expect(fetchMock.mock.calls[0]![0]).toBe('/api/agents/a1')
    expect(fetchMock.mock.calls[0]![1]).toMatchObject({ method: 'PATCH', body: JSON.stringify({ concurrency: 5 }) })
    expect(wrapper.text()).toContain('Saved')
    expect(toast.add).not.toHaveBeenCalled()
  })

  it('disables − at 1 and sends nothing', async () => {
    seed({ concurrency: 1 })
    const wrapper = mountStepper()
    expect(minus(wrapper).attributes('disabled')).toBeDefined()
    await minus(wrapper).trigger('click')
    vi.advanceTimersByTime(1000)
    await flushPromises()
    expect(number(wrapper)).toBe('1')
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('goes back to the saved value and toasts "Not saved" when the PATCH fails', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ error: { code: 'not_found' } }), { status: 404 }))
    const wrapper = mountStepper()
    await plus(wrapper).trigger('click')
    await plus(wrapper).trigger('click')
    expect(number(wrapper)).toBe('4')
    vi.advanceTimersByTime(600)
    await flushPromises()
    expect(number(wrapper)).toBe('2')
    expect(agent().concurrency).toBe(2)
    expect(toast.add).toHaveBeenCalledWith({ title: 'Not saved', description: 'Not found', color: 'error' })
    expect(wrapper.text()).not.toContain('Saved')
  })

  it.each([true, false])('serializes delayed writes and preserves newer taps (first succeeds: %s)', async (succeeds) => {
    let finishFirst!: (response: Response) => void
    let finishSecond!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finishFirst = resolve
    }))
      .mockImplementationOnce(() => new Promise<Response>((resolve) => {
        finishSecond = resolve
      }))
    const wrapper = mountStepper()
    await plus(wrapper).trigger('click')
    vi.advanceTimersByTime(600)
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    await plus(wrapper).trigger('click')
    vi.advanceTimersByTime(600)
    await flushPromises()
    expect(number(wrapper)).toBe('4')
    expect(fetchMock).toHaveBeenCalledTimes(1)
    finishFirst(succeeds ? ok({ concurrency: 3 }) : new Response('{}', { status: 404 }))
    await flushPromises()
    expect(number(wrapper)).toBe('4')
    expect(agent().concurrency).toBe(4)
    expect(wrapper.text()).not.toContain('Saved')
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]![1].body).toBe(JSON.stringify({ concurrency: 4 }))
    finishSecond(ok({ concurrency: 4 }))
    await flushPromises()
    expect(number(wrapper)).toBe('4')
    expect(agent().concurrency).toBe(4)
    expect(wrapper.text()).toContain('Saved')
    expect(toast.add).toHaveBeenCalledTimes(succeeds ? 0 : 1)
    wrapper.unmount()
  })

  it('rolls back to the latest confirmed write when a later write fails', async () => {
    let finishFirst!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finishFirst = resolve
    }))
      .mockResolvedValueOnce(new Response('{}', { status: 404 }))
    const wrapper = mountStepper()
    await plus(wrapper).trigger('click')
    vi.advanceTimersByTime(600)
    await plus(wrapper).trigger('click')
    finishFirst(ok({ concurrency: 3 }))
    await flushPromises()
    expect(number(wrapper)).toBe('4')
    vi.advanceTimersByTime(599)
    expect(fetchMock).toHaveBeenCalledTimes(1)
    vi.advanceTimersByTime(1)
    await flushPromises()
    expect(number(wrapper)).toBe('3')
    expect(agent().concurrency).toBe(3)
    expect(wrapper.text()).not.toContain('Saved')
    expect(toast.add).toHaveBeenCalledWith({ title: 'Not saved', description: 'Request failed (404)', color: 'error' })
    wrapper.unmount()
  })

  it('flushes newer taps on unmount after the current write finishes', async () => {
    let finishFirst!: (response: Response) => void
    fetchMock.mockImplementationOnce(() => new Promise<Response>((resolve) => {
      finishFirst = resolve
    })).mockResolvedValueOnce(ok({ concurrency: 4 }))
    const wrapper = mountStepper()
    await plus(wrapper).trigger('click')
    vi.advanceTimersByTime(600)
    await plus(wrapper).trigger('click')
    wrapper.unmount()
    expect(fetchMock).toHaveBeenCalledTimes(1)
    finishFirst(ok({ concurrency: 3 }))
    await flushPromises()
    expect(fetchMock).toHaveBeenCalledTimes(2)
    expect(fetchMock.mock.calls[1]![1].body).toBe(JSON.stringify({ concurrency: 4 }))
    expect(agent().concurrency).toBe(4)
    expect(toast.add).not.toHaveBeenCalled()
  })

  it('shows how many runs are going under the number', () => {
    seed({ activeRuns: 2 })
    expect(mountStepper().text()).toContain('2 running now')
    seed({ activeRuns: 0 })
    expect(mountStepper().text()).not.toContain('running now')
  })

  it('gives both buttons 44px targets and labels naming the agent', () => {
    const wrapper = mountStepper()
    for (const button of [minus(wrapper), plus(wrapper)]) expect(button.classes()).toContain('size-11')
    expect(wrapper.get('[aria-live="polite"]').text()).toBe('2')
  })
})
