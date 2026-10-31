// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { computed, defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FlowMetrics, Run, ServerEvent, Task } from '@corral/contracts'
import { applyEvent, invalidateKeys } from '~/queries/dependencies'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'

const flow = vi.hoisted(() => vi.fn())
vi.mock('~/composables/useApi', () => ({ api: { projects: { flow } } }))
for (const [name, value] of Object.entries({ computed, ref })) vi.stubGlobal(name, value)
const { default: ProjectFlow } = await import('./ProjectFlow.vue')
let client: ReturnType<typeof testQueryClient>
beforeEach(() => {
  client = testQueryClient()
  client.setQueryData(keys.projects.list(), [{ id: 'p1', slug: 'corral' }, { id: 'p2', slug: 'other' }])
})
// What the live connection does, without its timers
const emit = (event: ServerEvent) => invalidateKeys(client, applyEvent(client, event))
const sample = (days: number): FlowMetrics => ({
  window: '30d', mergedTaskCount: 1,
  leadTime: { medianMs: days * 86400000, p90Ms: days * 2 * 86400000 },
  cycleTime: { medianMs: days * 3600000, p90Ms: days * 2 * 3600000 },
  timeInStatus: [{ status: 'human_review', medianMs: 3600000, p90Ms: 7200000 }],
  runsByRole: [{ role: 'developer', duration: { medianMs: 60000, p90Ms: 120000 }, queueWait: { medianMs: 0, p90Ms: 60000 } }],
  averageDeveloperRuns: 1, slowestTasks: [{ ref: 'COR-1', leadTimeMs: days * 86400000, dominantStatus: 'human_review' }]
})
const mountFlow = () => mount(ProjectFlow, {
  props: { slug: 'corral' },
  global: {
    plugins: [[VueQueryPlugin, { queryClient: client }]],
    components: {
      UButton: defineComponent({ props: ['label'], setup: props => () => h('button', props.label) }),
      NuxtLink: defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) })
    },
    stubs: { USkeleton: true, UAlert: true }
  }
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

it('keeps the previous chart until the new window arrives, naming the window it shows', async () => {
  let resolve!: (value: FlowMetrics) => void
  flow.mockReset().mockResolvedValueOnce(sample(2)).mockImplementationOnce(() => new Promise((r) => {
    resolve = r
  }))
  const wrapper = mountFlow()
  await flushPromises()
  await wrapper.findAll('button')[0]!.trigger('click')
  await flushPromises()
  expect(flow).toHaveBeenLastCalledWith('corral', '7d')
  expect(wrapper.findComponent({ name: 'USkeleton' }).exists()).toBe(false)
  expect(wrapper.text()).toContain('2d lead')
  expect(wrapper.text()).toContain('in the last 30d')
  expect(wrapper.get('[aria-live]').attributes('aria-busy')).toBe('true')
  resolve({ ...sample(7), window: '7d' })
  await flushPromises()
  expect(wrapper.text()).toContain('7d lead')
  expect(wrapper.text()).toContain('in the last 7d')
  expect(wrapper.get('[aria-live]').attributes('aria-busy')).toBe('false')
  wrapper.unmount()
})

it('shows a window it has seen at once and refetches it behind', async () => {
  flow.mockReset().mockResolvedValueOnce(sample(2)).mockResolvedValueOnce({ ...sample(7), window: '7d' })
  const wrapper = mountFlow()
  await flushPromises()
  await wrapper.findAll('button')[0]!.trigger('click')
  await flushPromises()
  flow.mockImplementation(() => new Promise(() => {}))
  await wrapper.findAll('button')[1]!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('2d lead')
  expect(wrapper.get('[aria-live]').attributes('aria-busy')).toBe('false')
  wrapper.unmount()
})

it('clears figures for another project and renders an empty cohort and errors', async () => {
  flow.mockReset().mockResolvedValueOnce(sample(2)).mockResolvedValueOnce({ ...sample(0), window: '90d', mergedTaskCount: 0 })
    .mockImplementationOnce(() => new Promise(() => {}))
  const wrapper = mountFlow()
  await flushPromises()
  expect(wrapper.find('a').exists()).toBe(true)
  await wrapper.findAll('button')[2]!.trigger('click')
  await flushPromises()
  expect(wrapper.text()).toContain('No tasks merged in the last 90d')
  expect(wrapper.find('a').exists()).toBe(false)
  await wrapper.setProps({ slug: 'other' })
  await flushPromises()
  expect(wrapper.findComponent({ name: 'USkeleton' }).exists()).toBe(true)
  flow.mockRejectedValueOnce(new Error('Flow unavailable'))
  await wrapper.setProps({ slug: 'third' })
  await flushPromises()
  expect(wrapper.findComponent({ name: 'UAlert' }).exists()).toBe(true)
  wrapper.unmount()
})

const taskUpdated = (projectId: string): ServerEvent => ({ type: 'task.updated', task: { projectId } as Task })
const runUpdated = (projectId: string): ServerEvent => ({ type: 'run.updated', run: { projectId } as Run })
const taskDeleted = (projectId: string): ServerEvent => ({ type: 'task.deleted', taskId: 't1', projectId })
const mountLive = async () => {
  flow.mockReset().mockResolvedValue(sample(2))
  const wrapper = mountFlow()
  await flushPromises()
  return wrapper
}

it('ignores live events from other projects', async () => {
  const wrapper = await mountLive()
  await emit(runUpdated('p2'))
  await emit(taskUpdated('p2'))
  await emit(taskDeleted('p2'))
  await flushPromises()
  expect(flow).toHaveBeenCalledTimes(1)
  expect(wrapper.find('a').exists()).toBe(true)
  wrapper.unmount()
})

it('refreshes on same-project events and keeps the figures meanwhile', async () => {
  const wrapper = await mountLive()
  let resolve!: (value: FlowMetrics) => void
  flow.mockImplementationOnce(() => new Promise((r) => {
    resolve = r
  }))
  void emit(runUpdated('p1'))
  await flushPromises()
  expect(flow).toHaveBeenCalledTimes(2)
  expect(wrapper.findComponent({ name: 'USkeleton' }).exists()).toBe(false)
  expect(wrapper.text()).toContain('2d lead')
  resolve(sample(3))
  await flushPromises()
  expect(wrapper.text()).toContain('3d lead')
  await emit(taskDeleted('p1'))
  await flushPromises()
  expect(flow).toHaveBeenCalledTimes(3)
  wrapper.unmount()
})

it('keeps the figures when a live refresh fails', async () => {
  const wrapper = await mountLive()
  flow.mockRejectedValueOnce(new Error('Flow unavailable'))
  await emit(runUpdated('p1'))
  await flushPromises()
  expect(wrapper.findComponent({ name: 'UAlert' }).exists()).toBe(false)
  expect(wrapper.text()).toContain('2d lead')
  wrapper.unmount()
})

afterEach(() => client.clear())
