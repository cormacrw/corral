// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { keys } from '~/queries/keys'
import { applyEvent } from '~/queries/dependencies'
import { testQueryClient } from '~/queries/mount-with-query'
import type { Plan, PlanMessage, PlanSession, PlanSessionDetail, ServerEvent } from '@corral/contracts'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/queries/api'
import PlanConversation from '~/features/plan/components/PlanConversation.vue'
import PlanLiveTurn from '~/features/plan/components/PlanLiveTurn.vue'
import PlanMessages from '~/features/plan/components/PlanMessages.vue'
import PlanPill from '~/features/plan/components/PlanPill.vue'
import PlanQuestion from '~/features/plan/components/PlanQuestion.vue'
import PlanRefineMenu from '~/features/plan/components/PlanRefineMenu.vue'
import PlanRelatedThreads from '~/features/plan/components/PlanRelatedThreads.vue'
import PlanReplyComposer from '~/features/plan/components/PlanReplyComposer.vue'
import PlanRunnerOffline from '~/features/plan/components/PlanRunnerOffline.vue'
import PlanSessionHeader from '~/features/plan/components/PlanSessionHeader.vue'

vi.mock('~/queries/api', () => ({
  api: {
    plan: { session: vi.fn(), read: vi.fn(), message: vi.fn(), approve: vi.fn() },
    runs: { transcript: vi.fn() }
  }
}))

// Starts in flight are set by each test
vi.mock('~/queries/plan', async original => ({
  ...await original<typeof import('~/queries/plan')>(),
  usePlanStarts: () => ({ entries: pendingEntries, start: retryStart, seed: vi.fn() })
}))
vi.mock('~/features/plan/composables/usePlanStart', () => ({ useRestoredStart: () => restored }))

// The conversation column's measured width: narrow unless a test widens it
const columnWidth = vue.ref(800)
vi.mock('@vueuse/core', async original => ({
  ...await original<typeof import('@vueuse/core')>(),
  useElementSize: () => ({ width: columnWidth, height: vue.ref(0) })
}))

let client = testQueryClient()
let listener: (event: ServerEvent) => void
const pendingEntries = vue.ref<Record<string, { session: PlanSessionDetail, state: string, error: string | null, taskRef?: string }>>({})
const retryStart = vi.fn()
const restored = vue.ref(null)
const at = '2026-11-01T12:00:00.000Z'
const session = (id: string, title: string): PlanSession => ({
  id, projectId: 'p-1', title, runtime: 'claude-code', preview: '', unread: true, closed: false,
  status: 'none', activeRunId: null, createdAt: at, updatedAt: at
})
const message = (sessionId: string, id: string, role: 'human' | 'pm', text: string): PlanMessage =>
  ({ id, sessionId, role, kind: 'message', text, recommendation: null, options: null, planId: null, runId: null, createdAt: at })
const plan: Plan = {
  id: 'plan-1', sessionId: 's-1', projectId: 'p-1', epicId: null, version: 1, title: 'Billing plan', summary: '',
  status: 'proposed', approvedAt: null, epics: [], createdAt: at,
  tasks: [{ key: 'a', change: 'added', revises: false, taskId: null, epicId: null, ref: null, title: 'Invoice list', description: '', implementationPlan: '', status: null, priority: 'medium', humanReview: false, dependsOn: [] }]
}
const planSessions = [session('s-1', 'Billing page'), session('s-2', 'Notifications')]
const details: Record<string, PlanSessionDetail> = {
  's-1': { ...planSessions[0]!, plans: [plan], messages: [message('s-1', 'm-1', 'human', 'Add a billing page'), message('s-1', 'm-2', 'pm', 'Here is a plan for it')] },
  's-2': {
    ...planSessions[1]!, plans: [], messages: [
      message('s-2', 'm-3', 'human', 'Notify me when a run fails'),
      { ...message('s-2', 'q-1', 'pm', 'Which channel?'), kind: 'question', recommendation: null, options: ['Web Push', 'Email'] } as PlanMessage
    ]
  }
}
const state = vue.ref({
  loaded: true, runner: { online: true }, planSessions,
  agents: [{ id: 'a-pm', role: 'pm', name: 'Juno' }],
  projects: [{ id: 'p-1', slug: 'corral', name: 'Corral' }],
  runEvents: {} as Record<string, import('@corral/contracts').RunEvent[]>
})
const flyout = {
  ref: vue.ref<string | null>(null), epic: vue.ref<string | null>(null), plan: vue.ref(false),
  openPlan: vi.fn(), close: vi.fn()
}
const toast = { add: vi.fn() }
const push = vi.fn()
const mounted: { unmount: () => void }[] = []

// Stand-ins for what needs the Nuxt app: a composer with a textarea and a Send
// button, and a plan with a button per approval target
const PromptComposer = vue.defineComponent({
  props: { modelValue: String, disabled: Boolean, busy: Boolean, onSubmit: Function },
  emits: ['update:modelValue'],
  setup: (props, { emit }) => () => vue.h('form', {
    'aria-label': 'Reply',
    'data-busy': props.busy ? '' : undefined,
    'onSubmit': (e: Event) => {
      e.preventDefault()
      props.onSubmit?.(props.modelValue)
    }
  }, [
    vue.h('textarea', { value: props.modelValue, disabled: props.disabled, onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLTextAreaElement).value) }),
    vue.h('button', { type: 'submit', disabled: props.disabled || props.busy }, 'Send')
  ])
})
const PlanDetail = vue.defineComponent({
  props: { plan: { type: Object, required: true }, busy: Boolean, disabled: Boolean },
  emits: ['approve'],
  setup: (props, { emit }) => () => vue.h('section', { 'data-testid': 'plan' }, [
    vue.h('h3', (props.plan as Plan).title),
    ...['ready', 'backlog'].map(to => vue.h('button', { 'data-approve': to, 'disabled': props.disabled || props.busy, 'onClick': () => emit('approve', to) }, to))
  ])
})
const PlanSheets = vue.defineComponent({
  props: { plan: Object, busy: Boolean, disabled: Boolean },
  emits: ['approve'],
  setup: (props, { emit }) => () => props.plan
    ? vue.h('div', { 'data-testid': 'plan-sheet' }, vue.h(PlanDetail, { plan: props.plan, busy: props.busy, disabled: props.disabled, onApprove: (to: string) => emit('approve', to) }))
    : null
})
const composer = (wrapper: VueWrapper) => wrapper.get('form[aria-label="Reply"]')
const type = (wrapper: VueWrapper, text: string) => composer(wrapper).get('textarea').setValue(text)
const draft = (wrapper: VueWrapper) => (composer(wrapper).get('textarea').element as HTMLTextAreaElement).value
const button = vue.defineComponent({
  props: { label: String, to: String, disabled: Boolean },
  setup: (props, { attrs }) => () => vue.h(props.to ? 'a' : 'button', { ...attrs, href: props.to, disabled: props.disabled }, props.label)
})
const alertComponent = vue.defineComponent({
  props: ['title', 'description', 'actions'],
  setup: props => () => vue.h('div', { role: 'alert' }, [
    props.description,
    ...(props.actions ?? []).map((a: { label: string, onClick: () => void }) => vue.h('button', { onClick: a.onClick }, a.label))
  ])
})
function detail(id = 's-1'): PlanSessionDetail {
  return structuredClone(details[id]!)
}
async function open(id = 's-1', mobile = false) {
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(mobile) }))
  const wrapper = mount(PlanConversation, {
    props: { sessionId: id },
    global: {
      plugins: [[VueQueryPlugin, { queryClient: client }]],
      stubs: {
        PlanConfirmAction: true, AgentAvatar: true, PlanTurnSteps: true,
        TaskFlyout: true, AppDrawer: true, AppBadge: true, Icon: true,
        UiSkeleton: true, AppTooltip: true, AppSelectMenu: true,
        PlanGrillButton: true
      },
      components: {
        PromptComposer, PlanDetail, PlanSheets, PlanQuestion, PlanLiveTurn, PlanMessages, PlanPill, PlanRefineMenu, PlanRelatedThreads, PlanReplyComposer, PlanRunnerOffline, PlanSessionHeader,
        NuxtLink: vue.defineComponent({ name: 'NuxtLink', props: ['to'], setup: (props, { slots }) => () => vue.h('a', { href: props.to }, slots.default?.()) }),
        AppAlert: alertComponent,
        AppButton: button,
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
  vi.stubGlobal('usePlanThreads', () => ({ add: vi.fn() }))
  vi.stubGlobal('useTaskFlyout', () => flyout)
  vi.stubGlobal('useToast', () => toast)
  vi.stubGlobal('useProjectLists', () => ({ tasks: vue.ref([]) }))
  vi.stubGlobal('useShell', () => state.value)
  state.value.runner.online = true
  state.value.runEvents = {}
  state.value.planSessions = planSessions
  restored.value = null
  flyout.ref.value = null
  flyout.epic.value = null
  flyout.plan.value = false
  columnWidth.value = 800
  vi.mocked(api.plan.session).mockImplementation(async id => detail(id))
  vi.mocked(api.plan.read).mockResolvedValue({ ...planSessions[0]!, unread: false })
  vi.mocked(api.runs.transcript).mockResolvedValue([])
})

afterEach(() => {
  for (const wrapper of mounted.splice(0)) wrapper.unmount()
  vi.unstubAllGlobals()
})

describe('Plan conversation', () => {
  it.each([false, true])('links related threads and labels agent input on mobile=%s', async (mobile) => {
    const current = detail()
    current.parentSessionId = 'parent-thread'
    current.messages = [{ id: 'agent-message', sessionId: current.id, role: 'thread', senderSessionId: 'parent-thread', senderTitle: 'Coordinator', kind: 'message', text: 'Please check the entry point.', recommendation: null, options: null, planId: null, runId: null, createdAt: current.createdAt }]
    state.value.planSessions = [
      ...planSessions,
      { ...planSessions[0]!, id: 'parent-thread', title: 'Coordinator' },
      { ...planSessions[0]!, id: 'child-thread', parentSessionId: current.id, title: 'Routing check', closed: true }
    ]
    vi.mocked(api.plan.session).mockResolvedValue(current)
    const wrapper = await open(current.id, mobile)
    const nav = wrapper.get('[aria-label="Related threads"]')
    expect(nav.get('a[href="/plan/parent-thread"]').text()).toContain('Coordinator')
    expect(nav.get('a[href="/plan/child-thread"]').text()).toContain('Routing check')
    const message = wrapper.get('[data-message-id="agent-message"]')
    expect(message.get('a[href="/plan/parent-thread"]').text()).toContain('Coordinator')
    expect(message.text()).toContain('Please check the entry point.')
  })

  it('renders a pending start without fetching a nonexistent session, including working and failure recovery', async () => {
    const initial = detail()
    initial.id = 'pending-session'
    initial.plans = []
    initial.messages = [message('pending-session', 'pending-human', 'human', 'My unsent prompt')]
    pendingEntries.value[initial.id] = { session: initial, state: 'starting', error: null, taskRef: 'TA-1' }
    const wrapper = await open(initial.id)
    expect(api.plan.session).not.toHaveBeenCalled()
    expect(wrapper.text()).toContain('My unsent prompt')
    expect(wrapper.find('[data-transcript]').exists()).toBe(true)
    pendingEntries.value[initial.id]!.state = 'failed'
    pendingEntries.value[initial.id]!.error = 'Network unavailable'
    await vue.nextTick()
    expect(wrapper.find('[data-transcript]').exists()).toBe(false)
    const alert = wrapper.get('[role="alert"]')
    expect(alert.text()).toContain('Network unavailable')
    const action = (label: string) => alert.findAll('button').find(b => b.text() === label)!
    await action('Retry').trigger('click')
    expect(retryStart).toHaveBeenCalledWith(initial.id)
    await action('Back to prompt').trigger('click')
    await flushPromises()
    expect(restored.value).toMatchObject({ taskRef: 'TA-1' })
    expect(push).toHaveBeenCalledWith('/plan')
  })

  it('loads the selected session, marks it read and opens its plan', async () => {
    const wrapper = await open()
    expect(api.plan.session).toHaveBeenCalledWith('s-1')
    expect(api.plan.read).toHaveBeenCalledWith('s-1')
    expect(flyout.openPlan).toHaveBeenCalledWith({ replace: true })
    expect(wrapper.text()).toContain('Here is a plan for it')
  })

  it('switches sessions in place, keeping each thread\'s draft to itself', async () => {
    const wrapper = await open()
    await type(wrapper, 'A reply for the first thread')
    await wrapper.setProps({ sessionId: 's-2' })
    await flushPromises()
    expect(api.plan.session).toHaveBeenLastCalledWith('s-2')
    expect(draft(wrapper)).toBe('')
    expect(wrapper.text()).toContain('Notify me when a run fails')
    expect(wrapper.text()).not.toContain('Add a billing page')
    await wrapper.setProps({ sessionId: 's-1' })
    await flushPromises()
    expect(draft(wrapper)).toBe('A reply for the first thread')
  })

  it('sends a reply through Plan and renders live run events before the saved reply', async () => {
    const wrapper = await open()
    await type(wrapper, 'Keep this small.')
    await composer(wrapper).trigger('submit')
    await flushPromises()
    expect(api.plan.message).toHaveBeenCalledWith('s-1', 'Keep this small.', undefined)
    listener({ type: 'plan.session', session: { ...planSessions[0]!, activeRunId: 'live-run' } })
    await flushPromises()
    applyEvent(client, { type: 'run.events', runId: 'live-run', offset: 0, events: [{ type: 'message', text: 'I am checking the scope.' }] })
    await vue.nextTick()
    expect(wrapper.get('[data-transcript]').text()).toContain('I am checking the scope.')
    expect(composer(wrapper).get('textarea').attributes('disabled')).toBeDefined()
    const reply = { ...message('s-1', 'reply', 'pm', 'The scope is small.'), runId: 'live-run' }
    listener({ type: 'plan.message', message: reply })
    listener({ type: 'plan.session', session: { ...planSessions[0]!, activeRunId: null } })
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
    listener({ type: 'plan.session', session: { ...planSessions[0]!, title: 'Updated thread title', unread: false } })
    await flushPromises()
    expect(log.scrollTop).toBe(120)
  })

  it('shows a previously opened conversation immediately while its stale snapshot is delayed', async () => {
    const wrapper = await open()
    client.setQueryData(keys.plan.session('s-2'), detail('s-2'), { updatedAt: 1 })
    vi.mocked(api.plan.session).mockImplementation(() => new Promise(() => {}))
    await wrapper.setProps({ sessionId: 's-2' })
    expect(wrapper.text()).toContain('Notify me when a run fails')
    await wrapper.setProps({ sessionId: 's-1' })
    expect(wrapper.text()).toContain('Add a billing page')
  })

  it('sends a one-tap answer immediately without submitting the composer draft', async () => {
    const wrapper = await open('s-2')
    await type(wrapper, 'Unsent draft')
    await wrapper.findAll('button').find(b => b.text() === 'Web Push')!.trigger('click')
    await flushPromises()
    expect(api.plan.message).toHaveBeenCalledExactlyOnceWith('s-2', 'Web Push', undefined)
  })

  it('does not restore a one-tap answer draft into a different thread after the request finishes', async () => {
    const wrapper = await open('s-2')
    let finish!: () => void
    vi.mocked(api.plan.message).mockReturnValueOnce(new Promise((resolve) => {
      finish = () => resolve(detail('s-2').messages[0]!)
    }))
    await type(wrapper, 'Old draft')
    await wrapper.findAll('button').find(b => b.text() === 'Web Push')!.trigger('click')
    await wrapper.setProps({ sessionId: 's-1' })
    await flushPromises()
    expect(composer(wrapper).attributes('data-busy')).toBeUndefined()
    await type(wrapper, 'New draft')
    finish()
    await flushPromises()
    expect(draft(wrapper)).toBe('New draft')
  })

  it('approves from the plan sheet on phones', async () => {
    const wrapper = await open('s-1', true)
    expect(flyout.openPlan).not.toHaveBeenCalled()
    await wrapper.get('[data-testid="plan-pill"]').trigger('click')
    expect(flyout.openPlan).toHaveBeenCalledOnce()
    vi.mocked(api.plan.approve).mockResolvedValue({ ...plan, status: 'approved' as const })
    await wrapper.get('[data-testid="plan-sheet"] [data-approve="backlog"]').trigger('click')
    await flushPromises()
    expect(api.plan.approve).toHaveBeenCalledWith(plan.id, 'backlog')
  })

  it('keeps a failed approval in place for retry', async () => {
    const wrapper = await open('s-1', true)
    vi.mocked(api.plan.approve).mockRejectedValue(new Error('Approval failed'))
    await wrapper.get('[data-testid="plan-sheet"] [data-approve="ready"]').trigger('click')
    await flushPromises()
    expect(push).not.toHaveBeenCalled()
    expect(toast.add).toHaveBeenCalledWith(expect.objectContaining({ description: 'Approval failed', color: 'error' }))
    expect(wrapper.get('[data-testid="plan-sheet"] [data-approve="ready"]').attributes('disabled')).toBeUndefined()
  })

  it('disables approving while the PM is working, rather than ignoring the click', async () => {
    vi.mocked(api.plan.session).mockResolvedValue({ ...detail(), activeRunId: 'r-1' })
    const wrapper = await open('s-1', true)
    expect(wrapper.get('[data-testid="plan-sheet"] [data-approve="ready"]').attributes('disabled')).toBeDefined()
  })

  it('keeps a draft through leaving the conversation and clears it once sent', async () => {
    const first = await open()
    await type(first, 'Half a thought')
    first.unmount()
    const again = await open()
    expect(draft(again)).toBe('Half a thought')
    vi.mocked(api.plan.message).mockResolvedValue({ id: 'm', text: 'x' } as never)
    await composer(again).trigger('submit')
    await flushPromises()
    expect(sessionStorage.length).toBe(0)
  })

  describe('with room beside the thread', () => {
    beforeEach(() => {
      columnWidth.value = 1300
    })

    it('floats the latest plan beside the thread instead of opening the flyout', async () => {
      const wrapper = await open()
      expect(wrapper.get('[data-testid="plan-beside"]').text()).toContain('Billing plan')
      expect(flyout.openPlan).not.toHaveBeenCalled()
    })

    it('approves from the floating card', async () => {
      const wrapper = await open()
      vi.mocked(api.plan.approve).mockResolvedValue({ ...plan, status: 'approved' as const })
      await wrapper.get('[data-testid="plan-beside"] [data-approve="backlog"]').trigger('click')
      await flushPromises()
      expect(api.plan.approve).toHaveBeenCalledWith(plan.id, 'backlog')
    })

    it('disables the card while the PM works', async () => {
      vi.mocked(api.plan.session).mockResolvedValue({ ...detail(), activeRunId: 'r-1' })
      const wrapper = await open()
      expect(wrapper.get('[data-testid="plan-beside"] [data-approve="ready"]').attributes('disabled')).toBeDefined()
    })

    it('drops a ?plan flyout once the card is showing', async () => {
      flyout.plan.value = true
      await open()
      expect(flyout.close).toHaveBeenCalled()
    })

    it('updates the card in place when a new version arrives', async () => {
      const wrapper = await open()
      const next = { ...plan, id: 'plan-v2', version: 2, title: 'Revised plan' }
      listener({ type: 'plan.session', session: { ...planSessions[0]!, updatedAt: new Date().toISOString() } })
      client.setQueryData<PlanSessionDetail>(keys.plan.session('s-1'), old => old && { ...old, plans: [...old.plans, next] })
      await flushPromises()
      const cards = wrapper.findAll('[data-testid="plan-beside"]')
      expect(cards).toHaveLength(1)
      expect(cards[0]!.text()).toContain('Revised plan')
    })

    it('falls back to the flyout when the column is too narrow for both', async () => {
      const wrapper = await open()
      columnWidth.value = 860
      await flushPromises()
      expect(wrapper.find('[data-testid="plan-beside"]').exists()).toBe(false)
    })

    it('keeps the pill and sheets on phones', async () => {
      const wrapper = await open('s-1', true)
      expect(wrapper.find('[data-testid="plan-beside"]').exists()).toBe(false)
      expect(wrapper.find('[data-testid="plan-pill"]').exists()).toBe(true)
    })
  })
})
