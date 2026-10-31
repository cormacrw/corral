// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { keys } from '~/queries/keys'
import { applyEvent } from '~/queries/dependencies'
import { testQueryClient } from '~/queries/mount-with-query'
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

let client = testQueryClient()
let listener: (event: ServerEvent) => void
const pendingEntries = vue.ref<Record<string, { session: PlanSessionDetail, state: string, error: string | null, taskRef?: string }>>({})
const retryStart = vi.fn()
const restored = vue.ref(null)
const state = vue.ref({
  loaded: true, runner: { online: true }, agents, projects
})
const flyout = {
  ref: vue.ref<string | null>(null), epic: vue.ref<string | null>(null), plan: vue.ref(false),
  openPlan: vi.fn(), close: vi.fn()
}
const toast = { add: vi.fn() }
const push = vi.fn()
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
    props: { sessionId: id },
    global: {
      plugins: [[VueQueryPlugin, { queryClient: client }]],
      stubs: {
        PromptComposer: true, PlanQuestion: true,
        AgentAvatar: true, PlanTurnSteps: true, PlanDetail: true,
        TaskFlyout: true, PlanSheets: true, UDrawer: true, UBadge: true, UIcon: true,
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
  sessionStorage.clear()
  vi.clearAllMocks()
  client = testQueryClient()
  listener = (event) => {
    applyEvent(client, event)
  }
  for (const name of ['ref', 'computed', 'watch', 'nextTick', 'onMounted', 'onBeforeUnmount'] as const) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('useRouter', () => ({ push }))
  vi.stubGlobal('useSeoMeta', vi.fn())
  pendingEntries.value = {}
  vi.stubGlobal('usePendingPlan', () => ({ entries: pendingEntries, restored, start: retryStart }))
  vi.stubGlobal('usePlanThreads', () => ({ add: vi.fn() }))
  vi.stubGlobal('useTaskFlyout', () => flyout)
  vi.stubGlobal('useToast', () => toast)
  vi.stubGlobal('useProjectLists', () => ({ tasks: vue.ref([]) }))
  vi.stubGlobal('useShell', () => state.value)
  state.value.runner.online = true
  flyout.plan.value = false
  vi.mocked(api.plan.session).mockImplementation(async id => detail(id))
  vi.mocked(api.plan.read).mockResolvedValue({ ...planSessions[0]!, unread: false })
  vi.mocked(api.runs.transcript).mockResolvedValue([])
})

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.unstubAllGlobals()
})

describe('Plan conversation', () => {
  it('renders a pending start without fetching a nonexistent session, including working and failure recovery', async () => {
    const initial = detail()
    initial.id = 'pending-session'
    initial.plans = []
    initial.messages = [{ ...initial.messages[0]!, id: 'pending-human', role: 'human', kind: 'message', recommendation: null, options: null, text: 'My unsent prompt' }]
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

  it('loads the selected session, marks it read and opens its plan', async () => {
    const wrapper = await open()
    expect(api.plan.session).toHaveBeenCalledWith('s-1')
    expect(api.plan.read).toHaveBeenCalledWith('s-1')
    expect(flyout.openPlan).toHaveBeenCalledWith({ replace: true })
    expect(wrapper.find('a').attributes('href')).toBe('/plan')
    expect(wrapper.text()).toContain('Plan design tasks: prototypes the human approves before the build.')
  })

  it('switches sessions in place and replaces the composer so drafts and attachments are isolated', async () => {
    const wrapper = await open()
    const composer = wrapper.findComponent({ name: 'PromptComposer' })
    const previous = composer.element
    composer.vm.$emit('update:modelValue', 'A reply for the first thread')
    await wrapper.setProps({ sessionId: 's-2' })
    await flushPromises()
    expect(api.plan.session).toHaveBeenLastCalledWith('s-2')
    expect(wrapper.findComponent({ name: 'PromptComposer' }).element).not.toBe(previous)
    expect(wrapper.findComponent({ name: 'PromptComposer' }).vm.$attrs.modelValue).toBe('')
    expect(wrapper.text()).toContain(detail('s-2').title)
    expect(wrapper.text()).not.toContain(detail('s-1').title)
  })

  it('sends a reply through Plan and renders live run events before the saved reply', async () => {
    const wrapper = await open()
    const composer = wrapper.findComponent({ name: 'PromptComposer' })
    await composer.vm.$emit('submit', 'Keep this small.')
    await flushPromises()
    expect(api.plan.message).toHaveBeenCalledWith('s-1', 'Keep this small.', undefined)
    listener({ type: 'plan.session', session: { ...planSessions.find(s => s.id === 's-1')!, activeRunId: 'live-run' } })
    await flushPromises()
    applyEvent(client, { type: 'run.events', runId: 'live-run', offset: 0, events: [{ type: 'message', text: 'I am checking the scope.' }] })
    await vue.nextTick()
    expect(wrapper.get('[data-transcript]').text()).toContain('I am checking the scope.')
    expect(wrapper.findComponent({ name: 'PromptComposer' }).vm.$attrs.disabled).toBe(true)
    const message = { ...detail().messages[1]!, id: 'reply', text: 'The scope is small.', planId: null, runId: 'live-run' }
    listener({ type: 'plan.message', message })
    listener({ type: 'plan.session', session: { ...planSessions.find(s => s.id === 's-1')!, activeRunId: null } })
    await vue.nextTick()
    expect(wrapper.text()).toContain('The scope is small.')
  })

  it('opens a cached proposal on mount before a background snapshot returns', async () => {
    client.setQueryData(keys.plan.session('s-1'), detail())
    vi.mocked(api.plan.session).mockImplementation(() => new Promise(() => {}))
    await open()
    expect(flyout.openPlan).toHaveBeenCalledWith({ replace: true })
  })

  it('keeps scroll position when read echoes or background snapshots change metadata only', async () => {
    const wrapper = await open()
    const log = wrapper.get('[role="log"]').element as HTMLElement
    Object.defineProperty(log, 'scrollHeight', { value: 1000 })
    log.scrollTop = 120
    listener({ type: 'plan.session', session: { ...planSessions.find(s => s.id === 's-1')!, title: 'Updated thread title', unread: false } })
    await vue.nextTick()
    await vue.nextTick()
    expect(log.scrollTop).toBe(120)
  })

  it('shows a previously opened conversation immediately while its stale snapshot is delayed', async () => {
    const wrapper = await open()
    const second = detail('s-2')
    client.setQueryData(keys.plan.session('s-2'), second, { updatedAt: 1 })
    vi.mocked(api.plan.session).mockImplementation(() => new Promise(() => {}))
    await wrapper.setProps({ sessionId: 's-2' })
    expect(wrapper.text()).toContain(second.messages[0]!.text)
    expect(wrapper.findComponent({ name: 'USkeleton' }).exists()).toBe(false)
    await wrapper.setProps({ sessionId: 's-1' })
    expect(wrapper.text()).toContain(detail().messages[0]!.text)
  })

  it('sends a one-tap answer immediately without submitting the composer draft', async () => {
    const wrapper = await open('s-2')
    wrapper.findComponent({ name: 'PlanQuestion' }).vm.$emit('answer', 'Web Push')
    await flushPromises()
    expect(api.plan.message).toHaveBeenCalledWith('s-2', 'Web Push', undefined)
  })

  it('does not restore a one-tap answer draft into a different thread after the request finishes', async () => {
    const wrapper = await open('s-2')
    let finish!: () => void
    vi.mocked(api.plan.message).mockReturnValueOnce(new Promise((resolve) => {
      finish = () => resolve(detail('s-2').messages[0]!)
    }))
    wrapper.findComponent({ name: 'PromptComposer' }).vm.$emit('update:modelValue', 'Old draft')
    await vue.nextTick()
    wrapper.findComponent({ name: 'PlanQuestion' }).vm.$emit('answer', 'Web Push')
    await vue.nextTick()
    await wrapper.setProps({ sessionId: 's-1' })
    await flushPromises()
    const composer = wrapper.findComponent({ name: 'PromptComposer' })
    expect(composer.vm.$attrs.busy).toBe(false)
    composer.vm.$emit('update:modelValue', 'New draft')
    await vue.nextTick()
    finish()
    await flushPromises()
    expect(composer.vm.$attrs.modelValue).toBe('New draft')
  })

  it('approves from the plan sheet on phones', async () => {
    const wrapper = await open('s-1', true)
    expect(flyout.openPlan).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="plan-pill"]').trigger('click')
    expect(flyout.openPlan).toHaveBeenCalledOnce()
    vi.mocked(api.plan.approve).mockResolvedValue({ ...detail().plans[0]!, status: 'approved' as const })
    wrapper.findComponent({ name: 'PlanSheets' }).vm.$emit('approve', 'backlog')
    await flushPromises()
    expect(api.plan.approve).toHaveBeenCalledWith(detail().plans[0]!.id, 'backlog')
  })

  it('keeps a failed approval in place for retry', async () => {
    const wrapper = await open('s-1', true)
    vi.mocked(api.plan.approve).mockRejectedValue(new Error('Approval failed'))
    wrapper.findComponent({ name: 'PlanSheets' }).vm.$emit('approve', 'ready')
    await flushPromises()
    expect(push).not.toHaveBeenCalled()
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ title: 'Could not approve', color: 'error' }))
  })

  it('disables Add to board while Juno is working, rather than ignoring the click', async () => {
    vi.mocked(api.plan.session).mockResolvedValue({ ...detail(), activeRunId: 'r-1' })
    const wrapper = await open('s-1', true)
    expect(wrapper.findComponent({ name: 'PlanSheets' }).attributes('disabled')).toBe('true')
  })

  it('keeps a draft through leaving the conversation and clears it once sent', async () => {
    const first = await open()
    first.findComponent({ name: 'PromptComposer' }).vm.$emit('update:modelValue', 'Half a thought')
    await vue.nextTick()
    first.unmount()
    const again = await open()
    const composer = again.findComponent({ name: 'PromptComposer' })
    expect(composer.vm.$attrs.modelValue).toBe('Half a thought')
    vi.mocked(api.plan.message).mockResolvedValue({ id: 'm', text: 'x' } as never)
    composer.vm.$emit('submit', 'Half a thought')
    await flushPromises()
    expect(sessionStorage.length).toBe(0)
  })
})
