// @vitest-environment happy-dom
import { mount, flushPromises } from '@vue/test-utils'
import { computed, ref, watch, onMounted, onBeforeUnmount } from 'vue'
import { expect, it, vi } from 'vitest'
import type { FlowMetrics } from '@corral/contracts'

const flow = vi.hoisted(() => vi.fn())
vi.mock('~/composables/useApi', () => ({ api: { projects: { flow } } }))
for (const [name, value] of Object.entries({ computed, ref, watch, onMounted, onBeforeUnmount })) vi.stubGlobal(name, value)
vi.stubGlobal('useLive', () => ({ subscribe: () => () => {} }))
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
  props: { slug: 'corral' },
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
  expect(wrapper.text()).toContain('Run duration: 1m')
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
  await wrapper.setProps({ slug: 'other' })
  await flushPromises()
  expect(wrapper.findComponent({ name: 'UAlert' }).exists()).toBe(true)
  wrapper.unmount()
})
