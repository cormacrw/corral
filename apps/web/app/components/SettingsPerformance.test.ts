// @vitest-environment happy-dom
import type { PerfSummary, PerfWindow } from '@corral/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, ref, watch } from 'vue'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { testQueryClient } from '~/queries/mount-with-query'

// Nuxt auto-imports the section uses
vi.stubGlobal('computed', computed)
vi.stubGlobal('ref', ref)
vi.stubGlobal('watch', watch)

const perfSummary = vi.fn<(window: PerfWindow) => Promise<PerfSummary>>()
vi.mock('~/composables/useApi', () => ({ api: { perfSummary } }))

const { default: SettingsPerformance } = await import('./SettingsPerformance.vue')

const UTabs = defineComponent({
  props: ['modelValue', 'items'],
  emits: ['update:modelValue'],
  setup: (props, { emit }) => () => h('div', (props.items as { value: string }[]).map(item =>
    h('button', { 'data-window': item.value, 'onClick': () => emit('update:modelValue', item.value) }, item.value)))
})
const UCard = defineComponent({ setup: (_, { slots }) => () => h('div', [slots.header?.(), slots.default?.()]) })
const UBadge = defineComponent({ props: ['label'], setup: props => () => h('span', props.label) })
const UAlert = defineComponent({ props: ['title'], setup: props => () => h('div', { role: 'alert' }, props.title) })
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
    global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]], components: { UTabs, UCard, UBadge, UAlert }, stubs: { UIcon: true, USkeleton: true } }
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
    expect(wrapper.get('[data-testid="perf-empty"]').text()).toContain('Data appears here as the app is used')
    expect(wrapper.find('table').exists()).toBe(false)
  })

  it('marks rows over the threshold and rates each vital', async () => {
    perfSummary.mockResolvedValue(filled('24h', 900))
    const wrapper = mountSection()
    await flushPromises()
    const rows = wrapper.get('[data-testid="perf-routes"]').findAll('tbody tr')
    expect(rows.map(row => row.attributes('data-slow'))).toEqual(['true', undefined])
    expect(rows[0]!.classes()).toContain('bg-warning/10')
    expect(rows[0]!.text()).toContain('Slow')
    expect(rows[1]!.text()).not.toContain('Slow')
    expect(wrapper.get('[data-testid="perf-pages"] tbody tr').attributes('data-slow')).toBe('true')
    expect(wrapper.get('[data-testid="perf-vital-LCP"]').text()).toContain('Good')
    expect(wrapper.get('[data-testid="perf-vital-INP"]').text()).toContain('Needs improvement')
    expect(wrapper.get('[data-testid="perf-vital-CLS"]').text()).toContain('Poor')
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

  it('shows an error instead of stale figures', async () => {
    perfSummary.mockRejectedValue(new Error('Request failed (500)'))
    const wrapper = mountSection()
    await flushPromises()
    expect(wrapper.get('[role="alert"]').text()).toContain('Could not load')
  })
})
