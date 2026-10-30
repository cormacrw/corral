// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { afterEach, expect, it, vi } from 'vitest'
import type { FlowMetrics, Run, ServerEvent, Task } from '@corral/contracts'

const flow = vi.hoisted(() => vi.fn())
vi.mock('~/composables/useApi', () => ({ api: { projects: { flow } } }))
for (const [name, value] of Object.entries({ computed, ref, watch, onMounted, onBeforeUnmount })) vi.stubGlobal(name, value)
const listeners = new Set<(event: ServerEvent) => void>()
const emit = (event: ServerEvent) => listeners.forEach(listener => listener(event))
vi.stubGlobal('useLive', () => ({ subscribe: (listener: (event: ServerEvent) => void) => {
  listeners.add(listener)
  return () => listeners.delete(listener)
} }))
const { default: ProjectFlow } = await import('./ProjectFlow.vue')
const sample = (days: number): FlowMetrics => ({
  window: '30d', mergedTaskCount: 1,
  leadTime: { medianMs: days * 86400000, p90Ms: days * 2 * 86400000 },
  cycleTime: { medianMs: days * 3600000, p90Ms: days * 2 * 3600000 },
  timeInStatus: [{ status: 'human_review', medianMs: 3600000, p90Ms: 7200000 }],
  runsByRole: [{ role: 'developer', duration: { medianMs: 60000, p90Ms: 120000 }, queueWait: { medianMs: 0, p90Ms: 60000 } }],
  averageDeveloperRuns: 1, slowestTasks: [{ ref: 'COR-1', leadTimeMs: days * 86400000, dominantStatus: 'human_review' }]
})
const mountFlow = () => mount(ProjectFlow, {
  props: { slug: 'corral', projectId: 'p1' },
  global: { stubs: {
    UButton: { props: ['label'], template: '<button>{{ label }}</button>' },
    USkeleton: true, UAlert: true,
    NuxtLink: { props: ['to'], template: '<a :href="to"><slot /></a>' }
  } }
})

it('updates the whole cohort and ignores a late response from a previous window', async () => {
  let resolveOld!: (value: FlowMetrics) => void
  flow.mockReset().mockImplementationOnce(() => new Promise((resolve) => {
    resolveOld = resolve
  }))
    .mockResolvedValueOnce(sample(7))
  const wrapper = mountFlow()
  await wrapper.findAll('button')[0]!.trigger('click')
  await flushPromises()
  expect(flow).toHaveBeenLastCalledWith('corral', '7d')
  expect(wrapper.text()).toContain('7d')
  expect(wrapper.text()).toContain('Human wait')
  expect(wrapper.text()).toContain('Run duration: 1m 0s')
  expect(wrapper.text()).toContain('Queue wait (queued to started, including preparation): 0 ms · p90 1m 0s')
  expect(wrapper.get('a').attributes('href')).toBe('/tasks/COR-1')
  resolveOld(sample(30))
  await flushPromises()
  expect(wrapper.text()).not.toContain('30d · p90')
  expect(wrapper.text()).toContain('7d lead')
  wrapper.unmount()
})

it('clears figures while loading and renders an empty cohort and errors', async () => {
  flow.mockReset().mockResolvedValueOnce(sample(2)).mockResolvedValueOnce({ ...sample(0), mergedTaskCount: 0 })
    .mockRejectedValueOnce(new Error('Flow unavailable'))
  const wrapper = mountFlow()
  await flushPromises()
  expect(wrapper.find('a').exists()).toBe(true)
  await wrapper.findAll('button')[2]!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('No tasks merged in the last 90d')
  expect(wrapper.find('a').exists()).toBe(false)
  await wrapper.setProps({ slug: 'other', projectId: 'p2' })
  await flushPromises()
  expect(wrapper.findComponent({ name: 'UAlert' }).exists()).toBe(true)
  wrapper.unmount()
})

const taskUpdated = (projectId: string): ServerEvent => ({ type: 'task.updated', task: { projectId } as Task })
const runUpdated = (projectId: string): ServerEvent => ({ type: 'run.updated', run: { projectId } as Run })
const taskDeleted = (projectId: string): ServerEvent => ({ type: 'task.deleted', taskId: 't1', projectId })
afterEach(() => {
  vi.useRealTimers()
})
const mountLive = async () => {
  flow.mockReset().mockResolvedValue(sample(2))
  const wrapper = mountFlow()
  await flushPromises()
  vi.useFakeTimers()
  return wrapper
}

it('ignores live events from other projects', async () => {
  const wrapper = await mountLive()
  emit(runUpdated('p2'))
  emit(taskUpdated('p2'))
  emit(taskDeleted('p2'))
  await vi.advanceTimersByTimeAsync(5000)
  expect(flow).toHaveBeenCalledTimes(1)
  expect(wrapper.find('a').exists()).toBe(true)
  wrapper.unmount()
})

it('refreshes once per burst of same-project events and keeps the figures meanwhile', async () => {
  const wrapper = await mountLive()
  let resolve!: (value: FlowMetrics) => void
  flow.mockImplementationOnce(() => new Promise((r) => {
    resolve = r
  }))
  emit(runUpdated('p1'))
  emit(taskUpdated('p1'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(flow).toHaveBeenCalledTimes(2)
  expect(wrapper.findComponent({ name: 'USkeleton' }).exists()).toBe(false)
  expect(wrapper.text()).toContain('2d lead')
  resolve(sample(3))
  await vi.advanceTimersByTimeAsync(0)
  expect(wrapper.text()).toContain('3d lead')
  emit(taskDeleted('p1'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(flow).toHaveBeenCalledTimes(3)
  wrapper.unmount()
})

it('keeps the figures when a live refresh fails', async () => {
  const wrapper = await mountLive()
  flow.mockRejectedValueOnce(new Error('Flow unavailable'))
  emit(runUpdated('p1'))
  await vi.advanceTimersByTimeAsync(1000)
  expect(wrapper.findComponent({ name: 'UAlert' }).exists()).toBe(false)
  expect(wrapper.text()).toContain('2d lead')
  wrapper.unmount()
})

it('drops a pending refresh when the window changes or the component unmounts', async () => {
  const wrapper = await mountLive()
  emit(runUpdated('p1'))
  await wrapper.findAll('button')[0]!.trigger('click')
  await vi.advanceTimersByTimeAsync(5000)
  expect(flow).toHaveBeenCalledTimes(2)
  expect(flow).toHaveBeenLastCalledWith('corral', '7d')
  emit(runUpdated('p1'))
  wrapper.unmount()
  await vi.advanceTimersByTimeAsync(5000)
  expect(flow).toHaveBeenCalledTimes(2)
})
