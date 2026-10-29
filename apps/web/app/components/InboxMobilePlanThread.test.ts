// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { computed, defineComponent, h, onBeforeUnmount, onMounted, provide, ref, watch } from 'vue'
import { createRouter, createWebHistory, useRoute, useRouter } from 'vue-router'
import type { Plan, PlanThreadItem } from '@corral/contracts'
import { useTaskFlyout } from '~/composables/useTaskFlyout'
import InboxMobilePlanThread from './InboxMobilePlanThread.vue'
import PlanDetail from './PlanDetail.vue'

const mocks = vi.hoisted(() => ({
  message: vi.fn(), close: vi.fn(), session: vi.fn(), read: vi.fn(), approve: vi.fn(),
  replace: vi.fn(), refresh: vi.fn(), remove: vi.fn(), add: vi.fn(), toast: vi.fn()
}))
vi.mock('~/composables/useApi', () => ({ api: { plan: mocks } }))

const question: PlanThreadItem = {
  id: 's-2', sessionId: 's-2', type: 'plan_thread', taskId: null, taskRef: null, prUrl: null, resolution: null,
  project: { id: 'p', name: 'Test app', slug: 'test-app', thumbnailColor: null },
  sender: { name: 'Juno', role: 'pm' }, at: '', subject: 'Push notifications', preview: '', runtime: 'claude-code',
  status: 'question', question: { text: 'Which service?', recommendation: 'Web Push', options: ['ntfy'] },
  plan: null, planId: null, unread: false, activeRunId: null, reply: null
}
const plan = { id: 'plan-1', version: 1, title: 'Push plan', summary: 'Deliver notifications', tasks: [], epics: [], status: 'proposed' } as unknown as Plan
const planItem: PlanThreadItem = { ...question, question: null, status: 'needs_approval', planId: plan.id, plan: { ...plan, epicCount: 1, taskCount: 2 } }
const UButton = defineComponent({
  props: ['label', 'disabled', 'loading', 'ariaLabel'],
  setup: (p, { attrs, slots }) => () => h('button', { ...attrs, disabled: p.disabled || p.loading }, p.label ?? p.ariaLabel ?? slots.default?.())
})
const UDrawer = defineComponent({
  props: ['open', 'title'],
  emits: ['update:open'],
  setup: (p, { emit, slots }) => () => p.open
    ? h('section', { 'data-sheet': p.title }, [h('h2', p.title), slots.body?.(), slots.footer?.(), slots.content?.(), h('button', { onClick: () => emit('update:open', false) }, `Dismiss ${p.title}`)])
    : null
})
const UDropdownMenu = defineComponent({
  props: ['items'], setup: p => () => h('button', { onClick: () => p.items[0].onSelect() }, 'Close thread menu')
})
function screen(item = question) {
  return mount(InboxMobilePlanThread, {
    props: { item, onRefresh: mocks.refresh },
    global: {
      components: {
        UButton, UDrawer, UDropdownMenu,
        MobilePageHeader: defineComponent({ setup: (_, { slots }) => () => h('header', slots.actions?.()) }),
        PlanQuestion: defineComponent({ props: ['message', 'disabled'], emits: ['answer'], setup: (p, { emit }) => () => h('button', { disabled: p.disabled, onClick: () => emit('answer', 'ntfy') }, p.message.text) }),
        PromptComposer: defineComponent({ setup: () => () => h('textarea') }),
        MarkdownText: defineComponent({ props: ['text'], setup: p => () => h('p', p.text) }),
        PlanDetail: defineComponent({ setup: () => () => h('div') }),
        TaskDetail: defineComponent({ setup: () => () => h('div') }),
        EpicDetail: defineComponent({ setup: () => () => h('div') }),
        UAlert: defineComponent({ props: ['title'], setup: p => () => h('p', { role: 'alert' }, p.title) })
      }
    }
  })
}
const click = async (w: ReturnType<typeof screen>, label: string) => {
  await w.findAll('button').find(b => b.text() === label)!.trigger('click')
  await flushPromises()
}

beforeEach(() => {
  vi.resetAllMocks()
  for (const [name, value] of Object.entries({ computed, ref, watch, onMounted, onBeforeUnmount, provide })) vi.stubGlobal(name, value)
  vi.stubGlobal('useRouter', () => ({ replace: mocks.replace }))
  vi.stubGlobal('useLive', () => ({ state: ref({ loaded: true, runner: { online: true } }) }))
  vi.stubGlobal('usePlanThreads', () => ({ remove: mocks.remove, add: mocks.add }))
  vi.stubGlobal('useTaskFlyout', () => ({ plan: ref(false), ref: ref(null), epic: ref(null), close: vi.fn(), openPlan: vi.fn() }))
  vi.stubGlobal('useToast', () => ({ add: mocks.toast }))
  mocks.session.mockResolvedValue({ plans: [plan], messages: [{ text: 'Earlier conversation must stay hidden' }] })
  mocks.approve.mockResolvedValue(plan)
})

describe('focused mobile Plan thread', () => {
  it('shows the question and composer and submits the chosen answer to its session', async () => {
    const w = screen()
    expect(w.text()).toContain('Which service?')
    expect(w.find('textarea').exists()).toBe(true)
    expect(mocks.session).not.toHaveBeenCalled()
    await click(w, 'Which service?')
    expect(mocks.message).toHaveBeenCalledWith('s-2', 'ntfy')
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(mocks.replace).toHaveBeenCalledWith('/inbox')
  })

  it.each(['Approve to board', 'Approve to Backlog'])('shows the summary without conversation and handles %s', async (label) => {
    const w = screen(planItem)
    await flushPromises()
    expect(w.text()).toContain('Deliver notifications')
    expect(w.text()).toContain('Plan v1 · 1 epic · 2 tasks')
    expect(w.text()).not.toContain('Earlier conversation')
    expect(w.find('textarea').exists()).toBe(false)
    expect(w.text()).toContain('View plan')
    expect(w.text()).toContain('Open in Plan')
    await click(w, label)
    expect(mocks.approve).toHaveBeenCalledWith('plan-1', label === 'Approve to board' ? 'ready' : 'backlog')
    expect(mocks.replace).toHaveBeenCalledWith('/inbox')
  })

  it('asks before closing, supports Cancel, then refreshes before returning to Inbox', async () => {
    const w = screen()
    await click(w, 'Close thread menu')
    expect(w.text()).toContain('Close this thread?')
    expect(w.text()).toContain('draft tasks and the unapproved plan will be discarded')
    expect(mocks.close).not.toHaveBeenCalled()
    await click(w, 'Cancel')
    expect(w.text()).not.toContain('Close this thread?')
    expect(mocks.close).not.toHaveBeenCalled()
    await click(w, 'Close thread menu')
    await click(w, 'Close thread')
    expect(mocks.close).toHaveBeenCalledWith('s-2')
    expect(mocks.remove).toHaveBeenCalledWith('s-2')
    expect(mocks.refresh).toHaveBeenCalledOnce()
    expect(mocks.replace).toHaveBeenCalledWith('/inbox')
    expect(mocks.refresh.mock.invocationCallOrder[0]).toBeLessThan(mocks.replace.mock.invocationCallOrder[0]!)
  })

  it('keeps confirmation open and shows an error when closing fails', async () => {
    mocks.close.mockRejectedValue(new Error('Could not close'))
    const w = screen()
    await click(w, 'Close thread menu')
    await click(w, 'Close thread')
    expect(w.text()).toContain('Close this thread?')
    expect(w.text()).toContain('Could not close')
    expect(mocks.remove).not.toHaveBeenCalled()
    expect(mocks.replace).not.toHaveBeenCalled()
  })

  it('disables answers during a PM turn and explains that closing stops it', async () => {
    const w = screen({ ...question, activeRunId: 'run-1' })
    expect(w.findAll('button').find(b => b.text() === 'Which service?')!.attributes('disabled')).toBeDefined()
    expect(w.text()).toContain('Juno is working…')
    await click(w, 'Close thread menu')
    expect(w.text()).toContain('Juno\'s current turn will be stopped.')
  })
})

// The real router, flyout composable and PlanDetail on a phone, so a task
// tapped in the plan sheet takes the route PlanDetail really gives it
describe('a task opened from the mobile plan sheet', () => {
  const planned = { ...plan, epics: [], tasks: [{ key: 't1', change: 'added', revises: false, taskId: 't1', epicId: null, ref: 'TA-7', title: 'Send push', status: 'draft', priority: 'medium', humanReview: false, dependsOn: [] }] } as unknown as Plan
  const sheets = (w: ReturnType<typeof mount>) => w.findAll('[data-sheet]').map(s => s.attributes('data-sheet'))

  async function phone() {
    const page = defineComponent({ render: () => null })
    const router = createRouter({
      history: createWebHistory(),
      routes: [{ path: '/inbox/:itemId?', component: page }, { path: '/tasks/:ref', component: page }, { path: '/epics/:id', component: page }]
    })
    await router.push('/inbox/s-2')
    vi.stubGlobal('useRoute', useRoute)
    vi.stubGlobal('useRouter', useRouter)
    vi.stubGlobal('useDevice', () => ({ isMobile: computed(() => true) }))
    vi.stubGlobal('useTaskFlyout', useTaskFlyout)
    vi.stubGlobal('useLocalStorage', <T>(_key: string, fallback: T) => ref(fallback))
    vi.stubGlobal('useLive', () => ({ state: ref({ loaded: true, runner: { online: true } }), subscribe: () => () => {} }))
    mocks.session.mockResolvedValue({ plans: [planned], messages: [] })
    const stub = (tag = 'span') => defineComponent({ props: ['label'], setup: p => () => h(tag, p.label) })
    const w = mount(InboxMobilePlanThread, {
      props: { item: { ...planItem, planId: planned.id }, onRefresh: mocks.refresh },
      global: {
        plugins: [router],
        components: {
          UButton, UDrawer, UDropdownMenu, PlanDetail,
          UBadge: stub(), UIcon: stub(), UTabs: stub(), USkeleton: stub(), EpicGraph: stub('div'),
          MobilePageHeader: defineComponent({ setup: (_, { slots }) => () => h('header', slots.actions?.()) }),
          MarkdownText: defineComponent({ props: ['text'], setup: p => () => h('p', p.text) }),
          TaskDetail: defineComponent({ props: ['taskRef'], emits: ['close'], setup: (p, { emit }) => () => h('div', [`Task detail ${p.taskRef}`, h('button', { onClick: () => emit('close') }, 'Close task')]) }),
          EpicDetail: defineComponent({ setup: () => () => h('div') }),
          UAlert: defineComponent({ props: ['title'], setup: p => () => h('p', { role: 'alert' }, p.title) })
        }
      }
    })
    await flushPromises()
    return { w, router }
  }
  // Back finishes on the browser's popstate, after the click
  const settle = async (done: () => boolean) => {
    for (let i = 0; i < 50 && !done(); i++) await new Promise(r => setTimeout(r, 10))
    await flushPromises()
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
    await settle(() => !router.currentRoute.value.query.task)
    expect(router.currentRoute.value.path).toBe('/inbox/s-2')
    expect('plan' in router.currentRoute.value.query).toBe(true)
    expect(sheets(w)).toEqual(['Plan v1'])

    // The task's own close button goes back to the plan too
    await w.findAll('button').find(b => b.text().includes('Send push'))!.trigger('click')
    await flushPromises()
    await click(w, 'Close task')
    await settle(() => !router.currentRoute.value.query.task)
    expect(router.currentRoute.value.fullPath).toBe('/inbox/s-2?plan')
    expect(sheets(w)).toEqual(['Plan v1'])
  })
})
