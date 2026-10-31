// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { runs } from '~/prototype/fixtures'
import MobileAgentRun from '~/components/MobileAgentRun.vue'
import AgentPage from './[name].vue'
import AgentRunPage from './[name]/[[runId]].vue'

afterEach(() => {
  vi.unstubAllGlobals()
  instances.RunComposer = 0
  instances.RunTranscript = 0
})

// RunComposer's draft and RunTranscript's expanded steps live in their
// instances, so each run must get new ones
const instances = { RunComposer: 0, RunTranscript: 0 }
const counted = (name: keyof typeof instances) => vue.defineComponent({
  name,
  setup: () => {
    instances[name]++
    return () => vue.h('div')
  }
})

function runView() {
  const selected = vue.ref(runs[0]!)
  const view = {
    name: vue.ref('Juno'), agent: vue.ref({ name: 'Juno', role: 'pm', activeRuns: 0 }), runs: vue.ref(runs), error: vue.ref(null), events: vue.ref([]),
    now: vue.ref(Date.now()), selected, load: vi.fn(), today: vue.ref([]), tiles: vue.ref([]), facts: vue.ref(''), stop: vi.fn(), resume: vi.fn(), projectName: () => '', sent: vue.ref({})
  }
  return { view, selected }
}

async function expectNewInstances(selected: vue.Ref<typeof runs[number]>) {
  expect(instances).toEqual({ RunComposer: 1, RunTranscript: 1 })
  selected.value = { ...runs[1]!, id: 'next-run' }
  await flushPromises()
  expect(instances).toEqual({ RunComposer: 2, RunTranscript: 2 })
}
const global = {
  components: { RunComposer: counted('RunComposer'), RunTranscript: counted('RunTranscript'), UDashboardPanel: vue.defineComponent({ setup: (_, { slots }) => () => vue.h('div', slots.default?.()) }) },
  stubs: { UButton: true, UBadge: true, UAlert: true, USkeleton: true, AgentAvatar: true, TaskFlyout: true, RunTimingBreakdown: true, NuxtLink: true, UIcon: true }
}

it('gives each run its own composer and transcript on desktop', async () => {
  vi.stubGlobal('computed', vue.computed)
  const { view, selected } = runView()
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useTaskFlyout', () => ({}))
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  mount(AgentRunPage, { props: { view: view as never }, global })
  await expectNewInstances(selected)
})

function mountAgent(params: Record<string, string>, isMobile: boolean) {
  vi.stubGlobal('computed', vue.computed)
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useSeoMeta', vi.fn())
  vi.stubGlobal('useRoute', () => ({ params }))
  vi.stubGlobal('useRouter', () => ({}))
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

it('keeps the runs list beside the transcript with no run in the URL on the web', () => {
  const wrapper = mountAgent({ name: 'Juno' }, false)
  expect(wrapper.find('ul').exists()).toBe(true)
  expect(wrapper.find('[data-testid="child"]').exists()).toBe(true)
})

it('gives each run its own composer and transcript on mobile', async () => {
  vi.stubGlobal('computed', vue.computed)
  const { view, selected } = runView()
  mount(MobileAgentRun, { props: { view: view as never }, global })
  await expectNewInstances(selected)
})
