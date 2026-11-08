// @vitest-environment happy-dom
import type { Run } from '@corral/contracts'
import type { AgentRuns } from '~/features/agents/composables/useAgentRuns'
import { mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, ref } from 'vue'
import AgentHeader from '~/features/agents/components/AgentHeader.vue'
import MobileAgent from '~/features/agents/components/MobileAgent.vue'

const activity = vi.hoisted(() => ({ state: { loading: false, failed: false }, retry: vi.fn() }))
vi.mock('~/features/agents/composables/useAgentActivity', async () => {
  const { computed, ref } = await import('vue')
  return {
    ACTIVITY_DAYS: 7,
    hourTick: String,
    useAgentActivity: () => ({
      bars: ref([]), outcomes: ref([]), tokens: ref([]), lengths: ref(null),
      loading: computed(() => activity.state.loading), failed: computed(() => activity.state.failed),
      error: ref('500'), retry: activity.retry
    })
  }
})

const NuxtLink = defineComponent({
  props: ['to'],
  setup: (props, { slots }) => () => h('a', {
    href: typeof props.to === 'string' ? props.to : `${props.to.path}?${new URLSearchParams(props.to.query)}`
  }, slots.default?.())
})
const AppLoadError = defineComponent({
  props: ['title', 'retry'],
  setup: props => () => h('button', { 'data-testid': 'load-error', 'onClick': props.retry }, props.title)
})
const StatTile = defineComponent({
  props: ['label', 'value'],
  setup: props => () => h('div', { 'data-testid': 'tile' }, `${props.label} ${props.value}`)
})
const Slot = defineComponent({ setup: (_, { slots }) => () => h('section', { 'data-testid': 'chart-card' }, slots.default?.()) })
afterEach(() => {
  vi.unstubAllGlobals()
  activity.state = { loading: false, failed: false }
  activity.retry.mockReset()
})

function page(runs: Run[], state: Partial<{ pending: boolean, runsFailed: boolean }> = {}) {
  vi.stubGlobal('computed', computed)
  vi.stubGlobal('useDevice', () => ({ isMobile: ref(true) }))
  const view = {
    name: ref('Juno'), agent: ref({ id: 'a1', name: 'Juno', role: runs[0]?.role ?? 'developer', activeRuns: 0 }), status: ref(null), limited: ref(false),
    runs: ref(runs), pending: ref(state.pending ?? false), runsFailed: ref(state.runsFailed ?? false), current: ref(runs.find(r => r.state === 'running') ?? null),
    error: ref(state.runsFailed ? 'Request failed' : null), now: ref(Date.now()), today: ref([]),
    tiles: ref([{ label: 'Avg run', value: state.runsFailed ? '—' : '4m', sub: '' }]), facts: ref(''),
    load: vi.fn(), resume: vi.fn(), project: () => null
  } as unknown as AgentRuns
  return mount(MobileAgent, {
    props: { view }, global: { components: { NuxtLink, AppLoadError, StatTile, AgentHeader, DashboardCard: Slot }, stubs: {
      MobilePageHeader: true, AgentAvatar: true, AppBadge: true, AppButton: true, UiSkeleton: true,
      AgentsRunTimeline: true, AgentOutcomeChart: true, AgentsTokenChart: true, AgentRunSummary: true
    } }
  })
}
const run = (role: Run['role'], id = `r-${role}`) => ({
  id, role, agentId: 'juno', agentName: 'Juno', state: 'completed', outcome: null, projectId: 'p1', planSessionId: null,
  taskId: null, taskRef: null, taskTitle: null, epicId: null, epicTitle: null, summary: null,
  queuedAt: '2026-10-29T10:00:00Z', startedAt: '2026-10-29T10:00:00Z', endedAt: '2026-10-29T10:05:00Z'
}) as unknown as Run
const pm = run('pm')
const dev = run('developer')
const links = (runs: Run[]) => page(runs).findAll('a').map(a => a.attributes('href'))

describe('mobile agent navigation', () => {
  it('opens current and previous PM turns in their exact sessions and projects', () => {
    const current: Run = { ...pm, id: 'live', state: 'running', endedAt: null, outcome: null, planSessionId: 'live-session', projectId: 'project-a' }
    const previous: Run = { ...pm, id: 'past', planSessionId: 'past-session', projectId: 'project-b' }
    expect(links([current, previous])).toEqual([
      '/plan/live-session?project=project-a', '/plan/past-session?project=project-b'
    ])
  })

  it('keeps transcripts for unlinked PM turns and other roles even with a session ID', () => {
    expect(links([{ ...pm, planSessionId: null }])).toEqual([`/agents/juno/${pm.id}`])
    for (const role of ['developer', 'designer', 'reviewer'] as const) {
      const other = run(role)
      expect(links([{ ...other, planSessionId: 'session' }])).toEqual([`/agents/juno/${other.id}`])
    }
  })
})

describe('mobile agent states', () => {
  it('shows the three Activity charts and the runs once loaded', () => {
    const w = page([dev])
    expect(w.findAll('[data-testid="chart-card"]')).toHaveLength(3)
    expect(w.findAll('[data-testid="tile"]').map(t => t.text())).toEqual(['Avg run 4m'])
    expect(w.text()).toContain('idle')
    expect(w.findAll('a')).toHaveLength(1)
  })

  it('says how runs will appear for an agent with none', () => {
    const w = page([])
    expect(w.text()).toContain('idle')
    expect(w.text()).toContain('No runs yet')
  })

  it('shows skeletons and no run count while loading', () => {
    activity.state.loading = true
    const w = page([], { pending: true })
    expect(w.findAll('[data-testid="tile"]')).toHaveLength(0)
    expect(w.findAll('[data-testid="tile-skeleton"]').length).toBeGreaterThan(0)
    expect(w.findAll('[data-testid="chart-skeleton"]')).toHaveLength(3)
    expect(w.findAll('[data-testid="run-skeleton"]').length).toBeGreaterThan(0)
    expect(w.text()).not.toContain('today')
    expect(w.text()).not.toContain('No runs yet')
  })

  it('never guesses when the runs fail: Unavailable, the alerts, and one Retry for both', async () => {
    activity.state.failed = true
    const w = page([], { runsFailed: true })
    expect(w.find('[data-testid="current-run-unavailable"]').exists()).toBe(true)
    expect(w.find('[data-testid="previous-runs-unavailable"]').exists()).toBe(true)
    expect(w.text()).not.toContain('is idle')
    expect(w.text()).not.toContain('No runs yet')
    expect(w.text()).not.toContain('today')
    expect(w.findAll('[data-testid="chart-card"]')).toHaveLength(0)
    const errors = w.findAll('[data-testid="load-error"]')
    expect(errors).toHaveLength(2)
    expect(errors[1]!.text()).toContain('Juno')
    await errors[0]!.trigger('click')
    expect(activity.retry).toHaveBeenCalledTimes(1)
  })
})
