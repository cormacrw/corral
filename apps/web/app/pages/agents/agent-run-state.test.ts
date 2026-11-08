// @vitest-environment happy-dom
import { enableAutoUnmount, flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import type { Run } from '@corral/contracts'
import AgentDetail from '~/features/agents/components/AgentDetail.vue'
import AgentRunRow from '~/features/agents/components/AgentRunRow.vue'
import AgentRunPanel from '~/features/agents/components/AgentRunPanel.vue'
import MobileAgentRun from '~/features/agents/components/MobileAgentRun.vue'
import RunTranscriptPane from '~/features/runs/components/RunTranscriptPane.vue'
import AgentPage from './[name].vue'
import AgentRunPage from './[name]/[[runId]].vue'

enableAutoUnmount(afterEach)
afterEach(() => vi.unstubAllGlobals())

const run = (id: string, number: number): Run => ({
  runnerId: 'runner-1', runnerName: 'home', id, number, agentId: 'a-1', agentName: 'Juno', agentRuntime: 'claude', role: 'pm', projectId: 'p-1',
  planSessionId: null, taskId: null, taskRef: null, taskTitle: null, epicId: null, epicTitle: null, state: 'completed', outcome: null, summary: null,
  error: null, headSha: null, inputTokens: null, cacheReadTokens: null, outputTokens: null, rateLimitResetAt: null,
  queuedAt: '2026-11-04T11:00:00Z', startedAt: '2026-11-04T11:01:00Z', endedAt: '2026-11-04T11:10:00Z', timings: null
} as Run)
const runs = [run('run-1', 2), run('run-2', 1)]

// RunComposer's draft and RunTranscript's expanded steps live in their
// instances; these stand-ins hold some state the same way
const stateful = (name: string) => vue.defineComponent({
  name,
  setup: () => {
    const text = vue.ref('')
    return () => vue.h('textarea', { 'data-testid': name, 'value': text.value, 'onInput': (e: Event) => text.value = (e.target as HTMLTextAreaElement).value })
  }
})

function runView() {
  const selected = vue.ref(runs[0]!)
  const view = {
    name: vue.ref('Juno'), agent: vue.ref({ name: 'Juno', role: 'pm', activeRuns: 0 }), status: vue.ref(null), limited: vue.ref(false), runs: vue.ref(runs), error: vue.ref(null), events: vue.ref([]),
    now: vue.ref(Date.parse('2026-11-04T12:00:00Z')), selected, load: vi.fn(), today: vue.ref([]), tiles: vue.ref([]), facts: vue.ref(''), stop: vi.fn(), resume: vi.fn(), pending: vue.ref(false), runsFailed: vue.ref(false), project: () => ({ name: 'Corral', thumbnailColor: null }), projectName: () => 'Corral', sent: vue.ref({})
  }
  return { view, selected }
}

// Typing into both, then opening another run, leaves both empty
async function expectFreshStatePerRun(wrapper: VueWrapper, selected: vue.Ref<typeof runs[number]>) {
  for (const name of ['RunComposer', 'RunTranscript']) await wrapper.get(`[data-testid="${name}"]`).setValue('kept for this run')
  selected.value = { ...runs[1]!, id: 'next-run' }
  await flushPromises()
  for (const name of ['RunComposer', 'RunTranscript']) expect(wrapper.get<HTMLTextAreaElement>(`[data-testid="${name}"]`).element.value).toBe('')
}
const global = {
  components: { AgentDetail, AgentRunPanel, AgentRunRow, RunTranscriptPane, RunComposer: stateful('RunComposer'), RunTranscript: stateful('RunTranscript'), AppPanel: vue.defineComponent({ setup: (_, { slots }) => () => vue.h('div', slots.default?.()) }) },
  stubs: { AppButton: true, AppBadge: true, AppAlert: true, UiSkeleton: true, AgentAvatar: true, TaskFlyout: true, RunTimingBreakdown: true, NuxtLink: true, Icon: true, AgentDashboard: { render: () => vue.h('section', { 'data-testid': 'dashboard' }) } }
}

it('gives each run its own composer and transcript on desktop', async () => {
  vi.stubGlobal('computed', vue.computed)
  const { view, selected } = runView()
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useTaskFlyout', () => ({}))
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  await expectFreshStatePerRun(mount(AgentRunPage, { props: { view: view as never }, global }), selected)
})

function mountAgent(params: Record<string, string>, isMobile: boolean, push = vi.fn()) {
  vi.stubGlobal('computed', vue.computed)
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useSeoMeta', vi.fn())
  vi.stubGlobal('useRoute', () => ({ params }))
  vi.stubGlobal('useRouter', () => ({ push }))
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(isMobile) }))
  vi.stubGlobal('useAgentRuns', () => runView().view)
  return mount(AgentPage, { global: { ...global, components: { ...global.components, NuxtPage: { render: () => vue.h('main', { 'data-testid': 'child' }) }, MobileAgent: { render: () => vue.h('section', { 'data-testid': 'list' }) } } } })
}

it('shows the agent or the run on a phone, never both', () => {
  const agent = mountAgent({ name: 'Juno' }, true)
  expect(agent.find('[data-testid="list"]').exists()).toBe(true)
  expect(agent.find('[data-testid="child"]').exists()).toBe(false)
  const run = mountAgent({ name: 'Juno', runId: 'run-1' }, true)
  expect(run.find('[data-testid="list"]').exists()).toBe(false)
  expect(run.find('[data-testid="child"]').exists()).toBe(true)
})

it('lands on the dashboard on the web, even with a live run, and opens no run', () => {
  const wrapper = mountAgent({ name: 'Juno' }, false)
  expect(wrapper.find('[data-testid="dashboard"]').exists()).toBe(true)
  expect(wrapper.find('[data-testid="child"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="agent-activity-link"]').exists()).toBe(false)
})

it('shows the runs list beside the run on the web, with Activity back to the dashboard, and opens a run from it', async () => {
  const push = vi.fn()
  const wrapper = mountAgent({ name: 'Juno', runId: runs[0]!.id }, false, push)
  expect(wrapper.find('[data-testid="dashboard"]').exists()).toBe(false)
  expect(wrapper.find('[data-testid="child"]').exists()).toBe(true)
  expect(wrapper.get('[data-testid="agent-activity-link"]').attributes('to')).toBe('/agents/juno')
  const items = wrapper.findAll('li button')
  expect(items).toHaveLength(runs.length)
  expect(items[0]!.find('[data-testid="project-dot"]').exists()).toBe(true)
  await items[1]!.trigger('click')
  expect(push).toHaveBeenCalledWith(`/agents/juno/${runs[1]!.id}`)
})

it('gives each run its own composer and transcript on mobile', async () => {
  vi.stubGlobal('computed', vue.computed)
  const { view, selected } = runView()
  await expectFreshStatePerRun(mount(MobileAgentRun, { props: { view: view as never }, global }), selected)
})
