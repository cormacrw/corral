// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import type { Plan, PlanSession, ServerEvent } from '@corral/contracts'
import { applyEvent, invalidateKeys } from '~/queries/dependencies'
import { testQueryClient } from '~/queries/mount-with-query'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/queries/api'
import { inboxOf, planThread } from '~/features/inbox/test-items'
import InboxPlanThread from '~/features/inbox/components/InboxPlanThread.vue'
import InboxItemPane from '~/features/inbox/components/InboxItemPane.vue'
import InboxPage from '~/pages/inbox.vue'
import InboxItemPage from '~/pages/inbox/[itemId].vue'
import { UNDO_MS, usePlanThreadDelete } from '~/features/plan/composables/usePlanThreadDelete'

vi.mock('~/queries/api', () => ({
  api: { inbox: { get: vi.fn() }, plan: { session: vi.fn(), close: vi.fn(), read: vi.fn(), message: vi.fn() } }
}))

enableAutoUnmount(afterEach)
afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

const at = '2026-11-01T00:00:00.000Z'
const plan = {
  id: 'plan-1', sessionId: 's-1', projectId: 'p-1', epicId: null, version: 1, title: 'Push plan', summary: 'Deliver notifications',
  status: 'proposed', approvedAt: null, epics: [], createdAt: at,
  tasks: [{ key: 'T1', change: 'added', revises: false, taskId: 't-1', epicId: null, ref: 'COR-13', title: 'Send push', description: '', implementationPlan: '', status: 'draft', priority: 'medium', humanReview: false, dependsOn: [] }]
} as unknown as Plan
const session = (id: string): PlanSession => ({
  id, projectId: 'p-1', title: `Thread ${id}`, runtime: 'claude-code', preview: '', unread: false, closed: false,
  status: 'needs_approval', activeRunId: null, createdAt: at, updatedAt: at
}) as PlanSession
// A plan waiting on approval, then a question
const inbox = () => inboxOf([
  planThread('s-1', { sender: { name: 'Pam', role: 'pm' }, status: 'needs_approval', question: null, planId: plan.id, plan: { id: plan.id, version: 1, title: plan.title, summary: plan.summary, epicCount: 0, taskCount: 1 } }),
  planThread('s-3', { sender: { name: 'Pam', role: 'pm' } })
])
const shown = (wrapper: { get: (selector: string) => { text: () => string } }) => wrapper.get('[data-testid="inbox-plan-thread"]').text()

async function mountInbox(sessionPlans = [plan]) {
  for (const name of ['ref', 'shallowRef', 'computed', 'watch', 'watchEffect', 'onMounted', 'onBeforeUnmount', 'nextTick'] as const) vi.stubGlobal(name, vue[name])
  const replace = vi.fn()
  const remove = vi.fn()
  const toasts: { title: string, actions?: { label: string, onClick: () => void }[] }[] = []
  const toastRemove = vi.fn()
  const params = vue.reactive<{ itemId?: string }>({ itemId: 's-1' })
  vi.stubGlobal('useRoute', () => ({ params }))
  vi.stubGlobal('useRouter', () => ({ replace }))
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useSeoMeta', vi.fn())
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  vi.stubGlobal('useMobileHeader', () => vue.ref(null))
  vi.stubGlobal('useTaskPrefetch', () => () => undefined)
  vi.stubGlobal('useToast', () => ({ add: (t: typeof toasts[number]) => (toasts.push(t), { id: toasts.length }), remove: toastRemove }))
  vi.stubGlobal('usePlanThreads', () => ({ add: vi.fn(), remove }))
  vi.stubGlobal('usePlanThreadDelete', usePlanThreadDelete)
  vi.stubGlobal('useTaskFlyout', () => ({ ref: vue.ref(null), epic: vue.ref(null), plan: vue.ref(false), close: vi.fn().mockResolvedValue(undefined) }))
  vi.stubGlobal('useShell', () => ({ agents: [], projects: [], loaded: true, runner: { online: true } }))
  let data = inbox()
  vi.mocked(api.inbox.get).mockImplementation(async () => structuredClone(data))
  vi.mocked(api.plan.session).mockResolvedValue({ ...session('s-1'), messages: [], plans: sessionPlans })
  vi.mocked(api.plan.read).mockResolvedValue(session('s-1'))
  vi.mocked(api.plan.close).mockReset().mockImplementation(async (id) => {
    data = { ...data, needsYou: data.needsYou.filter(i => i.id !== id), count: data.count - 1 }
    return { ...session(id), closed: true }
  })
  const plain = vue.defineComponent({ name: 'Plain', setup: (_, { slots }) => () => vue.h('div', [slots.default?.(), slots.footer?.()]) })
  const button = vue.defineComponent({ props: ['label', 'ariaLabel'], setup: props => () => vue.h('button', props.label ?? props.ariaLabel) })
  const row = vue.defineComponent({ props: ['item'], setup: props => () => vue.h('span', { 'data-row': props.item.id }, props.item.subject) })
  // Sends what was typed
  const composer = vue.defineComponent({ emits: ['submit'], setup: (_, { emit, expose }) => {
    expose({ focus: () => {} })
    const text = vue.ref('')
    return () => vue.h('form', { onSubmit: (e: Event) => (e.preventDefault(), emit('submit', text.value)) }, [
      vue.h('textarea', { value: text.value, onInput: (e: Event) => text.value = (e.target as HTMLTextAreaElement).value })
    ])
  } })
  const avatar = vue.defineComponent({ props: ['name'], setup: props => () => vue.h('i', { 'data-avatar': props.name }) })
  const client = testQueryClient()
  // As Nuxt renders the child: keyed by its path
  const NuxtPage = vue.defineComponent({ setup: () => () => params.itemId ? vue.h(InboxItemPage, { key: params.itemId }) : null })
  const wrapper = mount(InboxPage, { global: { plugins: [[VueQueryPlugin, { queryClient: client }]], components: { NuxtPage, InboxItemPane, InboxPlanThread, AppPanel: plain, AppButton: button, AgentAvatar: avatar, PromptComposer: composer }, stubs: {
    InboxItemRow: row, PlanRunnerOffline: true,
    AppBadge: true, AppInput: true, AppTabs: true,
    MarkdownText: true, TaskFlyout: true,
    PlanConversation: true, InboxMobile: true, InboxMobileItem: true, AppAlert: true, AppLoadError: true, UiSkeleton: true, NuxtLink: true,
    EvidenceList: true, AppSelectMenu: true, Icon: true, PlanQuestion: true, PlanDetail: true
  } } })
  await flushPromises()
  // An event as the real stream delivers it, less the coalescing delay
  const emitLive = (event: { type: string, session?: { id: string, unread: boolean, activeRunId?: string | null }, markedRead?: true }) => void invalidateKeys(client, applyEvent(client, event as ServerEvent))
  const rows = () => wrapper.findAll('[data-row]').map(r => r.attributes('data-row'))
  const rename = (name: string) => {
    data = { ...data, needsYou: data.needsYou.map(i => i.type === 'plan_thread' ? { ...i, sender: { ...i.sender, name } } : i) }
    emitLive({ type: 'agent.updated' })
  }
  const setInbox = (next: typeof data) => {
    data = next
  }
  return { wrapper, params, replace, remove, toasts, toastRemove, rows, rename, setInbox, emitLive }
}

it('reads an unread thread in place, keeping it listed, without fetching the Inbox', async () => {
  const { wrapper, rows, emitLive, setInbox } = await mountInbox()
  setInbox(inboxOf(inbox().needsYou.map(i => i.id === 's-1' ? { ...i, unread: true } : i)))
  emitLive({ type: 'agent.updated' })
  await flushPromises()
  vi.mocked(api.inbox.get).mockClear()
  expect(rows()).toContain('s-1')
  expect(shown(wrapper)).toContain('Thread s-1')

  emitLive({ type: 'plan.session', session: { id: 's-1', unread: true } })
  await flushPromises()
  expect(api.plan.read).toHaveBeenCalledWith('s-1')
  expect(api.inbox.get).toHaveBeenCalledOnce()

  vi.mocked(api.inbox.get).mockClear()
  emitLive({ type: 'plan.session', session: { id: 's-1', unread: false }, markedRead: true })
  await flushPromises()
  expect(api.inbox.get).not.toHaveBeenCalled()
  expect(rows()).toContain('s-1')
  expect(shown(wrapper)).toContain('Thread s-1')
})

it('keeps a thread open after it leaves Needs you, until another item is picked', async () => {
  const { wrapper, params, setInbox, emitLive } = await mountInbox()
  setInbox(inboxOf(inbox().needsYou.filter(i => i.id !== 's-1')))
  emitLive({ type: 'agent.updated' })
  await flushPromises()
  expect(shown(wrapper)).toContain('Thread s-1')
  params.itemId = 's-3'
  await flushPromises()
  expect(shown(wrapper)).toContain('Thread s-3')
  expect(shown(wrapper)).not.toContain('Thread s-1')
})

it('shows the sender in the detail header, and a renamed PM without a reload', async () => {
  const { wrapper, rename } = await mountInbox()
  const meta = wrapper.getComponent(InboxPlanThread).get('[data-testid="inbox-meta"]')
  expect(meta.text()).toContain('Pam')
  rename('Renamed PM')
  await flushPromises()
  expect(meta.text()).toContain('Renamed PM')
  expect(meta.text()).not.toContain('Pam')
})

it('deletes from the header at once, selects the next item, and closes when Undo runs out', async () => {
  vi.useFakeTimers()
  const { wrapper, replace, remove, toasts, rows } = await mountInbox()
  expect(rows()).toContain('s-1')
  const thread = wrapper.getComponent(InboxPlanThread)
  await thread.findAll('button').find(b => b.text() === 'Delete thread')!.trigger('click')
  await flushPromises()
  expect(rows()).not.toContain('s-1')
  expect(toasts.at(-1)?.actions?.map(a => a.label)).toContain('Undo')
  expect(replace).toHaveBeenCalledWith({ path: '/inbox/s-3', query: {} })
  expect(api.plan.close).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(UNDO_MS)
  await flushPromises()
  expect(api.plan.close).toHaveBeenCalledWith('s-1')
  expect(remove).toHaveBeenCalledWith('s-1')
  expect(rows()).not.toContain('s-1')
})

it('has no delete on the row, and Undo brings a deleted thread back without closing', async () => {
  vi.useFakeTimers()
  const { wrapper, toasts, toastRemove, rows } = await mountInbox()
  const before = rows()
  const li = wrapper.findAll('li').find(li => li.find('[data-row="s-3"]').exists())!
  expect(li.findAll('button').some(b => b.text() === 'Delete thread')).toBe(false)
  await wrapper.getComponent(InboxPlanThread).findAll('button').find(b => b.text() === 'Delete thread')!.trigger('click')
  await flushPromises()
  expect(rows()).not.toContain('s-1')
  toasts.at(-1)!.actions![0]!.onClick()
  await flushPromises()
  expect(toastRemove).toHaveBeenCalled()
  expect(rows()).toEqual(before)
  await vi.advanceTimersByTimeAsync(UNDO_MS * 2)
  expect(api.plan.close).not.toHaveBeenCalled()
})

describe('while a sent reply is waiting on the PM', () => {
  it('stops saying working when the turn ended without a new message', async () => {
    const { wrapper, emitLive } = await mountInbox()
    vi.mocked(api.plan.message).mockResolvedValue({ id: 'm' } as never)
    await wrapper.findAll('button').find(b => b.text() === 'Request changes')!.trigger('click')
    await wrapper.get('textarea').setValue('Go on')
    await wrapper.get('form').trigger('submit')
    await flushPromises()
    expect(api.plan.message).toHaveBeenCalledWith('s-1', 'Go on', undefined)
    emitLive({ type: 'plan.session', session: { id: 's-1', unread: false, activeRunId: 'r-1' } })
    await flushPromises()
    expect(wrapper.find('[data-testid="inbox-plan-working"]').exists()).toBe(true)

    emitLive({ type: 'plan.session', session: { id: 's-1', unread: false, activeRunId: null } })
    await flushPromises()
    expect(wrapper.find('[data-testid="inbox-plan-working"]').exists()).toBe(false)
  })

  it('offers a retry when View plan has nothing to show', async () => {
    const { wrapper } = await mountInbox([])
    expect(wrapper.find('[data-testid="inbox-plan-error"]').exists()).toBe(true)
  })
})
