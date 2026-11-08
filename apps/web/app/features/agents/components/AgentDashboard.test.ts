// @vitest-environment happy-dom
import { enableAutoUnmount, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import type { Run } from '@corral/contracts'
import AgentDashboard from './AgentDashboard.vue'
import AgentRecentRuns from './AgentRecentRuns.vue'
import AgentRunRow from './AgentRunRow.vue'

enableAutoUnmount(afterEach)
afterEach(() => vi.unstubAllGlobals())

const run = (extra: Partial<Run>): Run => ({
  id: 'r', number: 1, agentId: 'a-dev', agentName: 'Victor', agentRuntime: 'claude', role: 'developer', projectId: 'p-1',
  planSessionId: null, taskId: 't-1', taskRef: 'COR-1', taskTitle: 'Fix the login', epicId: null, epicTitle: null, state: 'completed', outcome: 'pr_opened', summary: null,
  error: null, headSha: null, inputTokens: null, cacheReadTokens: null, outputTokens: null, rateLimitResetAt: null,
  queuedAt: '2026-11-04T10:00:00Z', startedAt: '2026-11-04T10:01:00Z', endedAt: '2026-11-04T10:30:00Z', timings: null, ...extra
} as Run)
const finished = run({ id: 'done', error: 'Hit its time limit' })
const live = run({ id: 'live', number: 2, state: 'running', outcome: null, endedAt: null })

function mountDashboard(state: { runs?: Run[], pending?: boolean, failed?: boolean, activity?: 'loading' | 'failed' | 'ok', lengths?: number[] | null }, push = vi.fn()) {
  const failed = state.failed ?? false
  const view = {
    name: vue.ref('Victor'), agent: vue.ref({ id: 'a-dev', name: 'Victor', role: 'developer' }),
    runs: vue.ref(state.runs ?? []), pending: vue.ref(state.pending ?? false), runsFailed: vue.ref(failed), error: vue.ref(failed ? 'Request failed' : null),
    now: vue.ref(Date.parse('2026-11-04T12:00:00Z')), load: vi.fn(),
    tiles: vue.ref([
      { label: 'Runs this week', value: failed ? '—' : '0', sub: failed ? 'Couldn\'t load runs' : '0 today', icon: 'i-hugeicons-play' },
      { label: 'Avg run', value: failed ? '—' : '12m', sub: 'this week', icon: 'i-hugeicons-clock-01', avg: true }
    ]),
    facts: vue.ref('Concurrency 2'), project: () => ({ name: 'Corral', thumbnailColor: '#123456' })
  }
  const retry = vi.fn()
  vi.stubGlobal('computed', vue.computed)
  vi.stubGlobal('useRouter', () => ({ push }))
  vi.stubGlobal('useAgentActivity', () => ({
    bars: vue.ref([]), outcomes: vue.ref([]), tokens: vue.ref([]), lengths: vue.ref(state.lengths ?? null),
    loading: vue.ref(state.activity === 'loading'), failed: vue.ref(state.activity === 'failed'), error: vue.ref(state.activity === 'failed' ? 'Request failed' : null), retry
  }))
  const marker = (name: string) => ({ props: ['empty', 'spark', 'label', 'value', 'hint', 'title', 'retry'], render(this: Record<string, unknown>) {
    const text = [this.label, this.value, this.hint, this.title].filter(Boolean).join(' ')
    return vue.h('div', { 'data-testid': name, 'data-empty': this.empty, 'data-spark': this.spark ? 'yes' : undefined }, this.retry ? [text, vue.h('button', { onClick: this.retry }, 'Retry')] : text)
  } })
  const wrapper = mount(AgentDashboard, {
    props: { view: view as never },
    global: {
      components: { AgentRecentRuns, AgentRunRow, DashboardCard: { props: ['title'], render(this: { title: string, $slots: vue.Slots }) {
        return vue.h('section', { 'data-card': this.title }, this.$slots.default?.())
      } } },
      stubs: { AppBadge: { props: ['label'], template: '<b data-testid="live-badge">{{ label }}</b>' }, UiSkeleton: { template: '<i data-skeleton />' }, StatTile: marker('tile'), AppLoadError: marker('load-error'), AgentsRunTimeline: marker('timeline'), AgentOutcomeChart: marker('outcomes'), AgentsTokenChart: marker('tokens') }
    }
  })
  return { wrapper, view, retry, push }
}

it('pins a live run first with a Live badge and opens a run from Recent runs', async () => {
  const { wrapper, push } = mountDashboard({ runs: [finished, live], activity: 'ok' })
  const rows = wrapper.findAll('[data-testid="agent-recent-runs"] button')
  expect(rows.map(r => r.attributes('data-live'))).toEqual(['true', undefined])
  expect(rows[0]!.find('[data-testid="live-badge"]').exists()).toBe(true)
  expect(rows[1]!.find('[data-testid="live-badge"]').exists()).toBe(false)
  expect(rows[1]!.find('[data-testid="project-dot"]').exists()).toBe(true)
  expect(rows[1]!.text()).toContain('Hit its time limit')
  await rows[1]!.trigger('click')
  expect(push).toHaveBeenCalledWith('/agents/victor/done')
})

it('gives the Avg tile a sparkline only with 2 or more days of finished runs', () => {
  const spark = (lengths: number[] | null) => mountDashboard({ runs: [finished], activity: 'ok', lengths }).wrapper.findAll('[data-testid="tile"]').map(t => t.attributes('data-spark'))
  expect(spark([10, 14])).toEqual([undefined, 'yes'])
  expect(spark(null)).toEqual([undefined, undefined])
})

it('says an agent with no runs has none yet', () => {
  const { wrapper } = mountDashboard({ runs: [], activity: 'ok' })
  expect(wrapper.text()).toContain('No runs yet')
  expect(wrapper.get('[data-testid="timeline"]').attributes('data-empty')).toContain('7 days')
})

it('shows skeletons while loading', () => {
  const { wrapper } = mountDashboard({ pending: true, activity: 'loading' })
  expect(wrapper.find('[data-testid="tile"]').exists()).toBe(false)
  for (const card of ['Runs', 'Outcomes', 'Tokens', 'Recent runs']) expect(wrapper.get(`[data-card="${card}"]`).find('[data-skeleton]').exists()).toBe(true)
})

it('makes nothing up when the runs fail to load, and retries runs and history', async () => {
  const { wrapper, view, retry } = mountDashboard({ failed: true, activity: 'failed' })
  expect(wrapper.findAll('[data-testid="tile"]').map(t => t.text())).toEqual(expect.arrayContaining([expect.stringContaining('—')]))
  // The Avg tile has no sparkline without the runs
  expect(wrapper.findAll('[data-spark]')).toHaveLength(0)
  const errors = wrapper.findAll('[data-testid="load-error"]')
  expect(errors).toHaveLength(2)
  expect(errors[0]!.text()).toContain('Victor')
  for (const card of ['Runs', 'Outcomes', 'Tokens']) {
    expect(wrapper.get(`[data-card="${card}"]`).find('[data-skeleton]').exists()).toBe(false)
    expect(wrapper.get(`[data-card="${card}"]`).text()).toContain('Unavailable')
  }
  expect(wrapper.text()).not.toContain('No runs')
  expect(wrapper.find('[data-testid="agent-recent-runs"]').exists()).toBe(false)
  await errors[0]!.get('button').trigger('click')
  expect(retry).toHaveBeenCalledOnce()
  await errors[1]!.get('button').trigger('click')
  expect(view.load).toHaveBeenCalledOnce()
})
