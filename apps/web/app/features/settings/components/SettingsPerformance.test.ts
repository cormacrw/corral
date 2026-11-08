// @vitest-environment happy-dom
import type { PerfSummary, PerfWindow } from '@corral/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, ref, watch } from 'vue'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { testQueryClient } from '~/queries/mount-with-query'
import { VITAL_RATING } from '~/features/settings/utils/performance'

// Nuxt auto-imports the section uses
vi.stubGlobal('computed', computed)
vi.stubGlobal('ref', ref)
vi.stubGlobal('watch', watch)

const perfSummary = vi.fn<(window: PerfWindow) => Promise<PerfSummary>>()
vi.mock('~/queries/api', () => ({ api: { perfSummary } }))

const { default: SettingsPerformance } = await import('~/features/settings/components/SettingsPerformance.vue')
const { default: SettingsPerfTable } = await import('~/features/settings/components/SettingsPerfTable.vue')

const AppTabs = defineComponent({
  props: ['modelValue', 'items'],
  emits: ['update:modelValue'],
  setup: (props, { emit }) => () => h('div', (props.items as { value: string }[]).map(item =>
    h('button', { 'data-window': item.value, 'onClick': () => emit('update:modelValue', item.value) }, item.value)))
})
const AppCard = defineComponent({ setup: (_, { slots }) => () => h('div', [slots.header?.(), slots.default?.()]) })
const AppBadge = defineComponent({ props: ['label'], setup: props => () => h('span', props.label) })
const AppLoadError = defineComponent({ props: ['title'], setup: props => () => h('div', { role: 'alert' }, props.title) })
const empty = (window: PerfWindow): PerfSummary => ({ window, slowThresholdMs: 500, routes: [], pages: [], vitals: { LCP: null, INP: null, CLS: null } })
const filled = (window: PerfWindow, p95Ms: number): PerfSummary => ({
  ...empty(window),
  routes: [
    { name: '/api/slow', count: 3, p50Ms: 100, p95Ms, maxMs: p95Ms, avgDbTimeMs: 10, avgQueries: 2.5 },
    { name: '/api/quick', count: 9, p50Ms: 5, p95Ms: 8, maxMs: 9, avgDbTimeMs: null, avgQueries: null }
  ],
  pages: [{ name: '/home', count: 2, p50Ms: 400, p95Ms: 501 }],
  vitals: { LCP: 2000, INP: 300, CLS: 0.3 }
})

function mountSection() {
  return mount(SettingsPerformance, {
    global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]], components: { AppTabs, AppCard, AppBadge, AppLoadError, SettingsPerfTable }, stubs: { Icon: true, UiSkeleton: true } }
  })
}

beforeEach(() => {
  perfSummary.mockReset()
})

describe('SettingsPerformance', () => {
  it('shows the empty state without samples', async () => {
    perfSummary.mockResolvedValue(empty('24h'))
    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.find('[data-testid="perf-empty"]').exists()).toBe(true)
    expect(wrapper.find('table').exists()).toBe(false)
  })

  it('marks rows over the threshold and rates each vital', async () => {
    perfSummary.mockResolvedValue(filled('24h', 900))
    const wrapper = mountSection()
    await flushPromises()
    const rows = wrapper.get('[data-testid="perf-routes"]').findAll('tbody tr')
    expect(rows.map(row => row.attributes('data-slow'))).toEqual(['true', undefined])
    expect(wrapper.get('[data-testid="perf-pages"] tbody tr').attributes('data-slow')).toBe('true')
    expect(wrapper.get('[data-testid="perf-vital-LCP"]').text()).toContain(VITAL_RATING.good.label)
    expect(wrapper.get('[data-testid="perf-vital-INP"]').text()).toContain(VITAL_RATING['needs-improvement'].label)
    expect(wrapper.get('[data-testid="perf-vital-CLS"]').text()).toContain(VITAL_RATING.poor.label)
  })

  it('loads the chosen window and ignores a slower earlier answer', async () => {
    perfSummary.mockResolvedValueOnce(filled('24h', 900))
    const wrapper = mountSection()
    await flushPromises()

    let finishHour!: (summary: PerfSummary) => void
    perfSummary.mockReturnValueOnce(new Promise((resolve) => {
      finishHour = resolve
    }))
    perfSummary.mockResolvedValueOnce(filled('7d', 7777))
    await wrapper.get('[data-window="1h"]').trigger('click')
    await wrapper.get('[data-window="7d"]').trigger('click')
    await flushPromises()
    finishHour(filled('1h', 111))
    await flushPromises()

    expect(perfSummary.mock.calls.map(([window]) => window)).toEqual(['24h', '1h', '7d'])
    expect(wrapper.get('[data-testid="perf-routes"]').text()).toContain('7.78 s')
  })

  it('shows an error instead of figures', async () => {
    perfSummary.mockRejectedValue(new Error('Request failed (500)'))
    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.find('[role="alert"]').exists()).toBe(true)
    expect(wrapper.find('[data-testid="perf-routes"]').exists()).toBe(false)
  })
})
