// @vitest-environment happy-dom
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { computed, defineComponent, h, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { FlowMetrics, Run, ServerEvent, Task } from '@corral/contracts'
import { applyEvent, invalidateKeys } from '~/queries/dependencies'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'

const flow = vi.hoisted(() => vi.fn())
vi.mock('~/queries/api', () => ({ api: { projects: { flow } } }))
for (const [name, value] of Object.entries({ computed, ref })) vi.stubGlobal(name, value)
const { default: ProjectFlow } = await import('~/features/projects/components/overview/ProjectFlow.vue')
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
  averageDeveloperRuns: 1, slowestTasks: [{ ref: 'COR-1', leadTimeMs: days * 86400000, dominantStatus: 'human_review' }],
  fixes: { reReviewed: 2, skippedReview: 5, epicDeveloperRuns: 3 }, epicReviews: { reviews: 6, epics: 4, perEpic: 1.5 }, sessions: [{ round: 'revision', sessionStart: 'resumed_warm', runs: 2, inputTokens: 10, cacheWriteTokens: 1000, cacheReadTokens: 500_000, outputTokens: 2000, costedRuns: 1, weightedCost: 0.14 }, { round: 'other', sessionStart: 'fresh', runs: 1, inputTokens: 5, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0, costedRuns: 0, weightedCost: 0 }], tokens: { firstBuild: 1_200_000, followUp: 300_000 }
})
enableAutoUnmount(afterEach)
const choose = (wrapper: VueWrapper, window: string) => wrapper.get('[aria-label="Flow window"]').findAll('button').find(b => b.text() === window)!.trigger('click')
// The slowest task's lead time, which differs per sample
const lead = (wrapper: VueWrapper) => wrapper.get('a[href="/tasks/COR-1"]').text()
const mountFlow = () => mount(ProjectFlow, {
  props: { slug: 'corral' },
  global: {
    plugins: [[VueQueryPlugin, { queryClient: client }]],
    components: {
      AppButton: defineComponent({ props: ['label'], setup: props => () => h('button', props.label) }),
      NuxtLink: defineComponent({ props: ['to'], setup: (props, { slots }) => () => h('a', { href: props.to }, slots.default?.()) })
    },
    stubs: { UiSkeleton: true, AppLoadError: true }
  }
})

it('loads the chosen window and ignores a late response from a previous window', async () => {
  let resolveOld!: (value: FlowMetrics) => void
  flow.mockReset().mockImplementationOnce(() => new Promise((resolve) => {
    resolveOld = resolve
  }))
    .mockResolvedValueOnce(sample(7))
  const wrapper = mountFlow()
  await choose(wrapper, '7d')
  await flushPromises()
  expect(flow).toHaveBeenLastCalledWith('corral', '7d')
  expect(lead(wrapper)).toContain('7d')
  resolveOld(sample(30))
  await flushPromises()
  expect(lead(wrapper)).toContain('7d')
})

it('keeps the previous chart until the new window arrives, naming the window it shows', async () => {
  let resolve!: (value: FlowMetrics) => void
  flow.mockReset().mockResolvedValueOnce(sample(2)).mockImplementationOnce(() => new Promise((r) => {
    resolve = r
  }))
  const wrapper = mountFlow()
  await flushPromises()
  await choose(wrapper, '7d')
  await flushPromises()
  expect(flow).toHaveBeenLastCalledWith('corral', '7d')
  expect(wrapper.findComponent({ name: 'UiSkeleton' }).exists()).toBe(false)
  expect(lead(wrapper)).toContain('2d')
  expect(wrapper.get('[aria-label="Rework"]').text()).toContain('30d')
  expect(wrapper.get('[aria-live]').attributes('aria-busy')).toBe('true')
  resolve({ ...sample(7), window: '7d' })
  await flushPromises()
  expect(lead(wrapper)).toContain('7d')
  expect(wrapper.get('[aria-label="Rework"]').text()).toContain('7d')
  expect(wrapper.get('[aria-live]').attributes('aria-busy')).toBe('false')
})

it('shows a window it has seen at once and refetches it behind', async () => {
  flow.mockReset().mockResolvedValueOnce(sample(2)).mockResolvedValueOnce({ ...sample(7), window: '7d' })
  const wrapper = mountFlow()
  await flushPromises()
  await choose(wrapper, '7d')
  await flushPromises()
  flow.mockImplementation(() => new Promise(() => {}))
  await choose(wrapper, '30d')
  await flushPromises()
  expect(lead(wrapper)).toContain('2d')
  expect(wrapper.get('[aria-live]').attributes('aria-busy')).toBe('false')
})

it('clears figures for another project and renders an empty cohort and errors', async () => {
  flow.mockReset().mockResolvedValueOnce(sample(2)).mockResolvedValueOnce({ ...sample(0), window: '90d', mergedTaskCount: 0 })
    .mockImplementationOnce(() => new Promise(() => {}))
  const wrapper = mountFlow()
  await flushPromises()
  expect(wrapper.find('a').exists()).toBe(true)
  await choose(wrapper, '90d')
  await flushPromises()
  expect(wrapper.find('a').exists()).toBe(false)
  await wrapper.setProps({ slug: 'other' })
  await flushPromises()
  expect(wrapper.findComponent({ name: 'UiSkeleton' }).exists()).toBe(true)
  flow.mockRejectedValueOnce(new Error('Flow unavailable'))
  await wrapper.setProps({ slug: 'third' })
  await flushPromises()
  expect(wrapper.findComponent({ name: 'AppLoadError' }).exists()).toBe(true)
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
  expect(wrapper.findComponent({ name: 'UiSkeleton' }).exists()).toBe(false)
  expect(lead(wrapper)).toContain('2d')
  resolve(sample(3))
  await flushPromises()
  expect(lead(wrapper)).toContain('3d')
  await emit(taskDeleted('p1'))
  await flushPromises()
  expect(flow).toHaveBeenCalledTimes(3)
})

it('keeps the figures when a live refresh fails', async () => {
  const wrapper = await mountLive()
  flow.mockRejectedValueOnce(new Error('Flow unavailable'))
  await emit(runUpdated('p1'))
  await flushPromises()
  expect(wrapper.findComponent({ name: 'AppLoadError' }).exists()).toBe(false)
  expect(lead(wrapper)).toContain('2d')
})

afterEach(() => client.clear())

it('shows the window\'s rework figures', async () => {
  flow.mockReset().mockResolvedValue(sample(1))
  const wrapper = mountFlow()
  await flushPromises()
  // 6 epic reviews across 4 parents
  expect(wrapper.get('[aria-label="Rework"]').text()).toContain('1.5')
})
