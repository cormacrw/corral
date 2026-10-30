// @vitest-environment happy-dom
import type { PlanSessionDetail, ServerEvent } from '@corral/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { agents, planMessages, plans, planSessions, projects } from '~/prototype/fixtures'
import { api } from '~/composables/useApi'
import PlanConversation from './PlanConversation.vue'

vi.mock('~/composables/useApi', () => ({
  api: {
    plan: { session: vi.fn(), read: vi.fn(), message: vi.fn(), approve: vi.fn() },
    runs: { transcript: vi.fn() }
  }
}))

let listener: (event: ServerEvent) => void
const pendingEntries = vue.ref<Record<string, { session: PlanSessionDetail, state: string, error: string | null, taskRef?: string }>>({})
const retryStart = vi.fn()
const restored = vue.ref(null)
const state = vue.ref({
  loaded: true, runner: { online: true }, agents, projects,
  tasks: {}, runEvents: {} as Record<string, import('@corral/contracts').RunEvent[]>
})
const flyout = {
  ref: vue.ref<string | null>(null), epic: vue.ref<string | null>(null), plan: vue.ref(false),
  openPlan: vi.fn(), close: vi.fn()
}
const toast = { add: vi.fn() }
const stop = vi.fn()
const push = vi.fn()
const onApproved = vi.fn()
const onApproving = vi.fn()
const mounted: { unmount: () => void }[] = []
const button = vue.defineComponent({
  props: { label: String, to: String, disabled: Boolean },
  setup: (props, { attrs }) => () => vue.h(props.to ? 'a' : 'button', { ...attrs, href: props.to, disabled: props.disabled }, props.label)
})
const alertComponent = vue.defineComponent({
  props: ['title', 'description', 'actions'],
  setup: props => () => vue.h('div', { 'data-alert': props.title }, props.description)
})
function detail(id = 's-1'): PlanSessionDetail {
  return structuredClone({
    ...planSessions.find(s => s.id === id)!,
    messages: planMessages[id] ?? [],
    plans: plans[id] ?? []
  })
}
async function open(id = 's-1', mobile = false) {
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(mobile) }))
  const wrapper = mount(PlanConversation, {
    props: { sessionId: id, inbox: true, onApproved, onApproving },
    global: {
      stubs: {
        PromptComposer: true, PlanQuestion: true,
        AgentAvatar: true, PlanTurnSteps: true, PlanDetail: true,
        TaskFlyout: true, UDrawer: true, UBadge: true, UIcon: true,
        USkeleton: true, UTooltip: true, USelectMenu: true,
        PlanSessionSwitcher: true, PlanGrillButton: true
      },
      components: {
        UAlert: alertComponent,
        UButton: button,
        MarkdownText: vue.defineComponent({
          props: { text: String },
          setup: props => () => vue.h('p', props.text)
        }),
        RunTranscript: vue.defineComponent({
          props: ['events'],
          setup: props => () => vue.h('div', { 'data-transcript': '' }, props.events.map((e: { text?: string }) => e.text).join(' '))
        })
      }
    }
  })
  mounted.push(wrapper)
  await flushPromises()
  return wrapper
}

beforeEach(() => {
  vi.clearAllMocks()
  for (const name of ['ref', 'computed', 'watch', 'nextTick', 'onMounted', 'onBeforeUnmount'] as const) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('useRouter', () => ({ push }))
  vi.stubGlobal('useSeoMeta', vi.fn())
  pendingEntries.value = {}
  vi.stubGlobal('usePendingPlan', () => ({ entries: pendingEntries, restored, start: retryStart }))
  vi.stubGlobal('usePlanThreads', () => ({ add: vi.fn() }))
  vi.stubGlobal('useTaskFlyout', () => flyout)
  vi.stubGlobal('useToast', () => toast)
  vi.stubGlobal('useLive', () => ({
    state,
    subscribe: (callback: typeof listener) => {
      listener = callback
      return stop
    },
    watchRun: (id: string, events: import('@corral/contracts').RunEvent[]) => { state.value.runEvents[id] = events }
  }))
  state.value.runner.online = true
  state.value.runEvents = {}
  flyout.plan.value = false
  vi.mocked(api.plan.session).mockImplementation(async id => detail(id))
  vi.mocked(api.plan.read).mockResolvedValue({ ...planSessions[0]!, unread: false })
  vi.mocked(api.runs.transcript).mockResolvedValue([])
})

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.unstubAllGlobals()
})

describe('Inbox shared Plan conversation', () => {
  it('renders a pending start without fetching a nonexistent session, including working and failure recovery', async () => {
    const initial = detail()
    initial.id = 'pending-session'
    initial.plans = []
    initial.messages = [{ ...initial.messages[0]!, id: 'pending-human', role: 'human', text: 'My unsent prompt' }]
    pendingEntries.value[initial.id] = { session: initial, state: 'starting', error: null, taskRef: 'TA-1' }
    const wrapper = await open(initial.id)
    expect(api.plan.session).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('My unsent prompt')
    expect(wrapper.find('[data-transcript]').exists()).toBe(true)
    pendingEntries.value[initial.id]!.state = 'failed'
    pendingEntries.value[initial.id]!.error = 'Network unavailable'
    await vue.nextTick()
    expect(wrapper.text()).toContain('Not sent')
    expect(wrapper.find('[data-transcript]').exists()).toBe(false)
    const alert = wrapper.getComponent(alertComponent)
    expect(alert.props('description')).toBe('Network unavailable')
    const actions = alert.props('actions') as { label: string, onClick: () => Promise<void> }[]
    await actions.find(a => a.label === 'Retry')!.onClick()
    expect(retryStart).toHaveBeenCalledWith(initial.id)
    await actions.find(a => a.label === 'Back to prompt')!.onClick()
    expect(restored.value).toMatchObject({ taskRef: 'TA-1' })
    expect(push).toHaveBeenCalledWith('/plan')
  })

  it('loads the selected session, marks it read, opens its plan and links to Plan', async () => {
    const wrapper = await open()
    expect(api.plan.session).toHaveBeenCalledWith('s-1')
    expect(api.plan.read).toHaveBeenCalledWith('s-1')
    expect(flyout.openPlan).toHaveBeenCalledWith({ replace: true })
    expect(wrapper.find('a').attributes('href')).toBe('/plan/s-1')
    expect(wrapper.text()).toContain('Plan design tasks: prototypes the human approves before the build.')
  })

  it('sends a reply through Plan and renders live run events before the saved reply', async () => {
    const wrapper = await open()
    const composer = wrapper.findComponent({ name: 'PromptComposer' })
    await composer.vm.$emit('submit', 'Keep this small.')
    await flushPromises()
    expect(api.plan.message).toHaveBeenCalledWith('s-1', 'Keep this small.', undefined)
    listener({ type: 'plan.session', session: { ...planSessions.find(s => s.id === 's-1')!, activeRunId: 'live-run' } })
    await flushPromises()
    state.value.runEvents['live-run'] = [{ type: 'message', text: 'I am checking the scope.' }]
    await vue.nextTick()
    expect(wrapper.get('[data-transcript]').text()).toContain('I am checking the scope.')
    expect(wrapper.findComponent({ name: 'PromptComposer' }).vm.$attrs.disabled).toBe(true)
    const message = { ...detail().messages[1]!, id: 'reply', text: 'The scope is small.', planId: null, runId: 'live-run' }
    listener({ type: 'plan.message', message })
    listener({ type: 'plan.session', session: { ...planSessions.find(s => s.id === 's-1')!, activeRunId: null } })
    await vue.nextTick()
    expect(wrapper.text()).toContain('The scope is small.')
  })

  it('sends a one-tap answer immediately without submitting the composer draft', async () => {
    const wrapper = await open('s-2')
    wrapper.findComponent({ name: 'PlanQuestion' }).vm.$emit('answer', 'Web Push')
    await flushPromises()
    expect(api.plan.message).toHaveBeenCalledWith('s-2', 'Web Push', undefined)
  })

  it.each(['ready', 'backlog'] as const)('confirms an approval to %s and signals advancement without navigating to Plan', async (to) => {
    const wrapper = await open()
    const approved = { ...detail().plans[0]!, status: 'approved' as const }
    vi.mocked(api.plan.approve).mockResolvedValue(approved)
    const label = to === 'ready' ? 'Approve to board' : 'Approve to Backlog'
    await wrapper.findAll('button').find(b => b.text() === label)!.trigger('click')
    expect(api.plan.approve).not.toHaveBeenCalled()
    wrapper.findComponent({ name: 'PromptComposer' }).vm.$emit('submit', '')
    await flushPromises()
    expect(api.plan.approve).toHaveBeenCalledWith(approved.id, to)
    expect(onApproving.mock.calls).toEqual([[true], [false]])
    expect(onApproved).toHaveBeenCalledOnce()
    expect(flyout.close).toHaveBeenCalled()
    expect(push).not.toHaveBeenCalled()
  })

  it('approves with one tap on phones and signals advancement', async () => {
    document.body.innerHTML = '<div id="mobile-header-actions"></div>'
    const wrapper = await open('s-1', true)
    expect(flyout.openPlan).not.toHaveBeenCalled()
    expect(wrapper.findAll('button').some(b => b.text() === 'Approve to board')).toBe(true)
    await wrapper.get('[data-testid="plan-pill"]').trigger('click')
    expect(flyout.openPlan).toHaveBeenCalledOnce()
    vi.mocked(api.plan.approve).mockResolvedValue({ ...detail().plans[0]!, status: 'approved' as const })
    await wrapper.findAll('button').find(b => b.text() === 'Approve to Backlog')!.trigger('click')
    await flushPromises()
    expect(api.plan.approve).toHaveBeenCalledWith(detail().plans[0]!.id, 'backlog')
    expect(onApproved).toHaveBeenCalledOnce()
    expect(push).not.toHaveBeenCalled()
  })

  it('keeps a failed approval in place for retry', async () => {
    const wrapper = await open()
    vi.mocked(api.plan.approve).mockRejectedValue(new Error('Approval failed'))
    await wrapper.findAll('button').find(b => b.text() === 'Approve to board')!.trigger('click')
    wrapper.findComponent({ name: 'PromptComposer' }).vm.$emit('submit', '')
    await flushPromises()
    expect(onApproved).not.toHaveBeenCalled()
    expect(onApproving.mock.calls).toEqual([[true], [false]])
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not approve', color: 'error' }))
  })
})
