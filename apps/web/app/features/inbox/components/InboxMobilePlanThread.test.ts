// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { testQueryClient } from '~/queries/mount-with-query'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { createMemoryHistory, createRouter, useRoute, useRouter } from 'vue-router'
import type { Plan, PlanThreadItem } from '@corral/contracts'
import { useTaskFlyout } from '~/composables/useTaskFlyout'
import InboxMobilePlanThread from '~/features/inbox/components/InboxMobilePlanThread.vue'
import InboxQuestionAnswer from '~/features/inbox/components/InboxQuestionAnswer.vue'
import PlanDetail from '~/features/plan/components/PlanDetail.vue'
import PlanSheets from '~/features/plan/components/PlanSheets.vue'

const mocks = vi.hoisted(() => ({
  message: vi.fn(), close: vi.fn(), session: vi.fn(), read: vi.fn(), approve: vi.fn(),
  replace: vi.fn(), remove: vi.fn(), add: vi.fn(), toast: vi.fn(), deleteThread: vi.fn(), moveToNext: vi.fn()
}))
vi.mock('~/queries/api', () => ({ api: { plan: mocks } }))
// The Inbox around the thread, which moves on to the next item
vi.mock('~/features/inbox/composables/useInboxView', () => ({ useInboxView: () => ({ moveToNext: mocks.moveToNext, deleteThread: mocks.deleteThread }) }))

const question: PlanThreadItem = {
  id: 's-2', sessionId: 's-2', type: 'plan_thread', taskId: null, taskRef: null, prUrl: null, resolution: null,
  project: { id: 'p', name: 'Test app', slug: 'test-app', thumbnailColor: null, thumbnailUrl: null },
  sender: { name: 'Juno', role: 'pm' }, at: '', subject: 'Push notifications', preview: '', runtime: 'claude-code',
  status: 'question', question: { text: 'Which service?', recommendation: 'Web Push', options: ['ntfy'] },
  plan: null, planId: null, unread: false, activeRunId: null, failure: null
}
const plan = { id: 'plan-1', version: 1, title: 'Push plan', summary: 'Deliver notifications', tasks: [], epics: [], status: 'proposed' } as unknown as Plan
const planItem: PlanThreadItem = { ...question, question: null, status: 'needs_approval', planId: plan.id, plan: { ...plan, epicCount: 1, taskCount: 2 } }
const AppButton = defineComponent({
  props: ['label', 'disabled', 'loading', 'ariaLabel'],
  setup: (p, { attrs, slots }) => () => h('button', { ...attrs, disabled: p.disabled || p.loading }, p.label ?? p.ariaLabel ?? slots.default?.())
})
const AppDrawer = defineComponent({
  props: ['open', 'title'],
  emits: ['update:open'],
  setup: (p, { emit, slots }) => () => p.open
    ? h('section', { 'data-sheet': p.title }, [h('h2', p.title), slots.body?.(), slots.footer?.(), slots.content?.(), h('button', { onClick: () => emit('update:open', false) }, `Dismiss ${p.title}`)])
    : null
})
const AppTextarea = defineComponent({
  props: ['modelValue'], emits: ['update:modelValue'],
  setup: (p, { attrs, emit }) => () => h('textarea', { ...attrs, value: p.modelValue, onInput: (e: Event) => emit('update:modelValue', (e.target as HTMLTextAreaElement).value) })
})
const AppDropdownMenu = defineComponent({
  props: ['items'], setup: p => () => h('button', { onClick: () => p.items[0].onSelect() }, p.items[0].label)
})
const mounted: { unmount: () => void }[] = []
function screen(item = question) {
  return track(mount(InboxMobilePlanThread, {
    props: { item },
    global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]],
      components: {
        AppButton, AppDrawer, AppDropdownMenu, PlanSheets,
        MobilePageHeader: defineComponent({ setup: (_, { slots }) => () => h('header', slots.actions?.()) }),
        PlanQuestion: defineComponent({
          props: ['message', 'disabled', 'writing'],
          emits: ['answer', 'other'],
          setup: (p, { emit, slots }) => () => h('div', [
            h('button', { disabled: p.disabled, onClick: () => emit('answer', 'ntfy') }, p.message.text),
            h('button', { onClick: () => emit('other') }, 'Other…'),
            p.writing ? slots.other?.() : null
          ])
        }),
        AppTextarea, InboxQuestionAnswer,
        PlanRunnerOffline: defineComponent({ setup: () => () => null }),
        PromptComposer: defineComponent({ setup: () => () => h('textarea') }),
        MarkdownText: defineComponent({ props: ['text'], setup: p => () => h('p', p.text) }),
        AgentAvatar: defineComponent({ setup: () => () => h('span') }),
        PlanDetail: defineComponent({ setup: () => () => h('div') }),
        AsyncTaskDetail: defineComponent({ setup: () => () => h('div') }),
        AsyncEpicDetail: defineComponent({ setup: () => () => h('div') }),
        AppAlert: defineComponent({ props: ['title'], setup: p => () => h('p', { role: 'alert' }, p.title) })
      }
    }
  }))
}
function track<T extends { unmount: () => void }>(wrapper: T) {
  mounted.push(wrapper)
  return wrapper
}
const click = async (w: ReturnType<typeof screen>, label: string) => {
  await w.findAll('button').find(b => b.text() === label)!.trigger('click')
  await flushPromises()
}

afterEach(() => {
  mounted.splice(0).forEach(w => w.unmount())
  vi.unstubAllGlobals()
})
beforeEach(() => {
  vi.resetAllMocks()
  for (const [name, value] of Object.entries({ computed, ref, watch, onMounted, onBeforeUnmount, provide })) vi.stubGlobal(name, value)
  vi.stubGlobal('useRouter', () => ({ replace: mocks.replace }))
  vi.stubGlobal('useShell', () => ({ loaded: true, runner: { online: true } }))
  vi.stubGlobal('usePlanThreads', () => ({ remove: mocks.remove, add: mocks.add }))
  vi.stubGlobal('useTaskFlyout', () => ({ plan: ref(false), ref: ref(null), epic: ref(null), close: vi.fn(), openPlan: vi.fn() }))
  vi.stubGlobal('useToast', () => ({ add: mocks.toast }))
  vi.stubGlobal('usePlanThreadDelete', () => ({ remove: mocks.deleteThread, pending: ref([]) }))
  mocks.session.mockResolvedValue({ plans: [plan], messages: [{ text: 'Earlier conversation must stay hidden' }] })
  mocks.approve.mockResolvedValue(plan)
})

describe('focused mobile Plan thread', () => {
  it('shows the question without a reply box and submits the chosen answer to its session', async () => {
    const w = screen()
    expect(w.text()).toContain('Which service?')
    expect(w.find('textarea').exists()).toBe(false)
    expect(mocks.session).toHaveBeenCalledWith('s-2')
    await click(w, 'Which service?')
    expect(mocks.message).toHaveBeenCalledWith('s-2', 'ntfy', undefined)
    // The thread stays open while the PM's turn streams in, as on the web
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it('writes Other… inside the question and sends it with Submit', async () => {
    const w = screen()
    expect(w.find('[data-testid="inbox-primary"]').exists()).toBe(false)
    await click(w, 'Other…')
    const input = w.get('[data-testid="plan-question-other"]')
    expect(w.get('[data-testid="inbox-primary"]').attributes('disabled')).toBeDefined()
    await input.setValue('Web Push, with ntfy later')
    await click(w, 'Submit')
    expect(mocks.message).toHaveBeenCalledWith('s-2', 'Web Push, with ntfy later', undefined)
  })

  it.each(['Approve to board', 'Approve to Backlog'])('shows the summary without conversation and handles %s', async (label) => {
    const w = screen(planItem)
    await flushPromises()
    expect(w.text()).toContain('Deliver notifications')
    expect(w.text()).not.toContain('Earlier conversation')
    expect(w.find('textarea').exists()).toBe(false)
    await click(w, label)
    expect(mocks.approve).toHaveBeenCalledWith('plan-1', label === 'Approve to board' ? 'ready' : 'backlog')
    expect(mocks.moveToNext).toHaveBeenCalled()
  })

  it('shows a failed turn with a reply box that retries in its session', async () => {
    mocks.session.mockResolvedValue({ unread: true, plans: [], messages: [] })
    const failed: PlanThreadItem = { ...question, question: null, status: 'failed', unread: true, failure: 'The PM exited with code 1' }
    mocks.read.mockResolvedValue(undefined)
    const w = screen(failed)
    await flushPromises()
    expect(w.text()).toContain('The PM exited with code 1')
    expect(w.find('textarea').exists()).toBe(true)
    expect(mocks.read).toHaveBeenCalledWith('s-2')
  })

  it('deletes from the menu without asking and moves on through the Inbox', async () => {
    const w = screen()
    await click(w, 'Delete thread')
    // The Inbox deletes it, waits out Undo before closing, and moves on
    expect(mocks.deleteThread).toHaveBeenCalledWith(question)
    expect(mocks.close).not.toHaveBeenCalled()
  })

  it('disables answers during a PM turn', async () => {
    const w = screen({ ...question, activeRunId: 'run-1' })
    expect(w.findAll('button').find(b => b.text() === 'Which service?')!.attributes('disabled')).toBeDefined()
    expect(w.text()).toContain('working')
  })
})

// The real router, flyout composable and PlanDetail on a phone, so a task
// tapped in the plan sheet takes the route PlanDetail really gives it
describe('while Juno is working', () => {
  it('disables approving, on the screen and for the plan sheet', async () => {
    const w = screen({ ...planItem, activeRunId: 'r-1' })
    await flushPromises()
    const approve = w.findAll('button').filter(b => b.text().startsWith('Approve to'))
    expect(approve).toHaveLength(2)
    for (const button of approve) expect(button.attributes('disabled')).toBeDefined()
    expect(mocks.approve).not.toHaveBeenCalled()
  })

  it('goes by the session when the item is an old snapshot', async () => {
    mocks.session.mockResolvedValue({ activeRunId: 'r-1', plans: [plan], messages: [] })
    const w = screen(planItem)
    await flushPromises()
    expect(w.findAll('button').find(b => b.text() === 'Approve to board')!.attributes('disabled')).toBeDefined()
  })
})

describe('a task opened from the mobile plan sheet', () => {
  const planned = { ...plan, epics: [], tasks: [{ key: 't1', change: 'added', revises: false, taskId: 't1', epicId: null, ref: 'TA-7', title: 'Send push', status: 'draft', priority: 'medium', humanReview: false, dependsOn: [] }] } as unknown as Plan
  const sheets = (w: ReturnType<typeof mount>) => w.findAll('[data-sheet]').map(s => s.attributes('data-sheet'))

  async function phone() {
    const page = defineComponent({ render: () => null })
    const router = createRouter({
      history: createMemoryHistory(),
      routes: [{ path: '/inbox/:itemId?', component: page }, { path: '/tasks/:ref', component: page }, { path: '/epics/:id', component: page }]
    })
    await router.push('/inbox/s-2')
    vi.stubGlobal('useRoute', useRoute)
    vi.stubGlobal('useRouter', useRouter)
    vi.stubGlobal('useDevice', () => ({ isMobile: computed(() => true) }))
    vi.stubGlobal('useTaskFlyout', useTaskFlyout)
    vi.stubGlobal('useLocalStorage', <T>(_key: string, fallback: T) => ref(fallback))
    vi.stubGlobal('useShell', () => ({ loaded: true, runner: { online: true } }))
    mocks.session.mockResolvedValue({ plans: [planned], messages: [] })
    const stub = (tag = 'span') => defineComponent({ props: ['label'], setup: p => () => h(tag, p.label) })
    const w = track(mount(InboxMobilePlanThread, {
      props: { item: { ...planItem, status: 'needs_approval', question: null, plan: { id: planned.id, version: planned.version, title: planned.title, summary: planned.summary, epicCount: 0, taskCount: 0 }, planId: planned.id, failure: null } },
      global: { plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }], router],
        components: {
          AppButton, AppDrawer, AppDropdownMenu, PlanDetail, PlanSheets, PlanRunnerOffline: stub(),
          AppBadge: stub(), Icon: stub(), AppTabs: stub(), UiSkeleton: stub(), AsyncEpicGraph: stub('div'),
          MobilePageHeader: defineComponent({ setup: (_, { slots }) => () => h('header', slots.actions?.()) }),
          MarkdownText: defineComponent({ props: ['text'], setup: p => () => h('p', p.text) }),
          AsyncTaskDetail: defineComponent({ props: ['taskRef'], emits: ['close'], setup: (p, { emit }) => () => h('div', [`Task detail ${p.taskRef}`, h('button', { onClick: () => emit('close') }, 'Close task')]) }),
          AsyncEpicDetail: defineComponent({ setup: () => () => h('div') }),
          AppAlert: defineComponent({ props: ['title'], setup: p => () => h('p', { role: 'alert' }, p.title) })
        }
      }
    }))
    await flushPromises()
    return { w, router }
  }

  it('opens the task in a taller sheet over the plan on the Inbox route, and Back returns to the plan', async () => {
    const { w, router } = await phone()
    await click(w, 'View plan')
    expect(router.currentRoute.value.path).toBe('/inbox/s-2')
    expect(sheets(w)).toEqual(['Plan v1'])

    await w.findAll('button').find(b => b.text().includes('Send push'))!.trigger('click')
    await flushPromises()
    expect(router.currentRoute.value.path).toBe('/inbox/s-2')
    expect(router.currentRoute.value.query.task).toBe('TA-7')
    expect(sheets(w)).toEqual(['Plan v1', 'Task TA-7'])
    expect(w.text()).toContain('Task detail TA-7')

    await click(w, 'Dismiss Task TA-7')
    expect(router.currentRoute.value.path).toBe('/inbox/s-2')
    expect('plan' in router.currentRoute.value.query).toBe(true)
    expect(sheets(w)).toEqual(['Plan v1'])

    // The task's own close button goes back to the plan too
    await w.findAll('button').find(b => b.text().includes('Send push'))!.trigger('click')
    await flushPromises()
    await click(w, 'Close task')
    expect(router.currentRoute.value.fullPath).toBe('/inbox/s-2?plan')
    expect(sheets(w)).toEqual(['Plan v1'])
  })
})
