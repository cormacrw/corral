// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import type { ServerEvent } from '@corral/contracts'
import { applyEvent, invalidateKeys } from '~/queries/dependencies'
import { testQueryClient } from '~/queries/mount-with-query'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/composables/useApi'
import { agents, inbox, planSessions, plans, projects } from '~/prototype/fixtures'
import InboxPlanThread from '~/components/InboxPlanThread.vue'
import InboxPage from '~/pages/inbox/[[itemId]].vue'
import { UNDO_MS, usePlanThreadDelete } from '~/composables/usePlanThreadDelete'

vi.mock('~/composables/useApi', () => ({
  api: { inbox: { get: vi.fn() }, plan: { session: vi.fn(), close: vi.fn(), read: vi.fn() } }
}))

afterEach(() => {
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

async function mountInbox() {
  for (const name of ['ref', 'shallowRef', 'computed', 'watch', 'watchEffect', 'onMounted', 'onBeforeUnmount'] as const) vi.stubGlobal(name, vue[name])
  const replace = vi.fn()
  const remove = vi.fn()
  const toasts: { title: string, actions?: { label: string, onClick: () => void }[] }[] = []
  const toastRemove = vi.fn()
  vi.stubGlobal('useRoute', () => ({ params: { itemId: 's-1' } }))
  vi.stubGlobal('useRouter', () => ({ replace }))
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useSeoMeta', vi.fn())
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  vi.stubGlobal('useMobileHeader', () => vue.ref(null))
  vi.stubGlobal('useToast', () => ({ add: (t: typeof toasts[number]) => (toasts.push(t), { id: toasts.length }), remove: toastRemove }))
  vi.stubGlobal('usePlanThreads', () => ({ add: vi.fn(), remove }))
  vi.stubGlobal('usePlanThreadDelete', usePlanThreadDelete)
  vi.stubGlobal('useTaskFlyout', () => ({ ref: vue.ref(null), epic: vue.ref(null), plan: vue.ref(false), close: vi.fn().mockResolvedValue(undefined) }))
  vi.stubGlobal('useLive', () => ({ state: vue.ref({ agents, projects, loaded: true, runner: { online: true } }) }))
  let data = inbox()
  vi.mocked(api.inbox.get).mockImplementation(async () => structuredClone(data))
  vi.mocked(api.plan.session).mockResolvedValue({ ...planSessions.find(s => s.id === 's-1')!, unread: false, messages: [], plans: plans['s-1']! })
  vi.mocked(api.plan.close).mockReset().mockImplementation(async (id) => {
    data = { ...data, needsYou: data.needsYou.filter(i => i.id !== id), count: data.count - 1 }
    return { ...planSessions.find(s => s.id === id)!, closed: true }
  })
  const plain = vue.defineComponent({ name: 'Plain', setup: (_, { slots }) => () => vue.h('div', [slots.default?.(), slots.footer?.()]) })
  const button = vue.defineComponent({ props: ['label', 'ariaLabel'], setup: props => () => vue.h('button', props.label ?? props.ariaLabel) })
  const row = vue.defineComponent({ props: ['item'], setup: props => () => vue.h('span', { 'data-row': props.item.id }, props.item.subject) })
  const avatar = vue.defineComponent({ props: ['name'], setup: props => () => vue.h('i', { 'data-avatar': props.name }) })
  const client = testQueryClient()
  const wrapper = mount(InboxPage, { global: { plugins: [[VueQueryPlugin, { queryClient: client }]], components: { InboxPlanThread, UDashboardPanel: plain, UButton: button, PlanThreadRow: row, AgentAvatar: avatar }, stubs: {
    UBadge: true, UInput: true, UTabs: true,
    MarkdownText: true, TaskFlyout: true,
    PlanConversation: true, InboxMobile: true, UAlert: true, USkeleton: true, NuxtLink: true,
    EvidenceList: true, USelectMenu: true, PromptComposer: true, UIcon: true, PlanQuestion: true, PlanDetail: true
  } } })
  await flushPromises()
  // An event as the real stream delivers it, less the coalescing delay
  const emitLive = (event: { type: string, session?: { id: string, unread: boolean }, markedRead?: { inboxCount: number } }) => void invalidateKeys(client, applyEvent(client, event as ServerEvent))
  const rows = () => wrapper.findAll('[data-row]').map(r => r.attributes('data-row'))
  const rename = (name: string) => {
    data = { ...data, needsYou: data.needsYou.map(i => i.type === 'plan_thread' ? { ...i, sender: { ...i.sender, name } } : i) }
    emitLive({ type: 'agent.updated' })
  }
  const setInbox = (next: typeof data) => {
    data = next
  }
  return { wrapper, replace, remove, toasts, toastRemove, rows, rename, setInbox, emitLive }
}

it('reads an unread thread in place and keeps it open, without fetching the Inbox', async () => {
  const { wrapper, rows, emitLive, setInbox } = await mountInbox()
  try {
    const opened = inbox().needsYou.find(i => i.id === 's-1')
    if (opened?.type !== 'plan_thread') throw new Error('fixture')
    setInbox({ ...inbox(), needsYou: inbox().needsYou.map(i => i.id === 's-1' ? { ...opened, status: 'none', question: null, plan: null, planId: null, unread: true, reply: 'Done' } : i) })
    emitLive({ type: 'agent.updated' })
    await flushPromises()
    vi.mocked(api.inbox.get).mockClear()
    vi.mocked(api.plan.read).mockResolvedValue({ ...planSessions.find(s => s.id === 's-1')!, unread: false })
    expect(rows()).toContain('s-1')

    emitLive({ type: 'plan.session', session: { id: 's-1', unread: true } })
    await flushPromises()
    expect(api.plan.read).toHaveBeenCalledWith('s-1')
    expect(api.inbox.get).toHaveBeenCalledOnce()

    vi.mocked(api.inbox.get).mockClear()
    emitLive({ type: 'plan.session', session: { id: 's-1', unread: false }, markedRead: { inboxCount: 1 } })
    await flushPromises()
    expect(api.inbox.get).not.toHaveBeenCalled()
    expect(rows()).not.toContain('s-1')
    expect(wrapper.findComponent(InboxPlanThread).exists()).toBe(true)
  } finally {
    wrapper.unmount()
  }
})

it('shows the sender in the detail header, and a renamed PM without a reload', async () => {
  const { wrapper, rename } = await mountInbox()
  try {
    const header = wrapper.getComponent(InboxPlanThread).get('header')
    expect(header.text()).toContain('Pam · PM')
    expect(header.text()).toContain(projects[0]!.name)
    expect(header.get('[data-avatar]').attributes('data-avatar')).toBe('Pam')
    rename('Renamed PM')
    await flushPromises()
    expect(header.text()).toContain('Renamed PM · PM')
    expect(header.get('[data-avatar]').attributes('data-avatar')).toBe('Renamed PM')
  } finally {
    wrapper.unmount()
  }
})

it('deletes from the header at once, selects the next item, and closes when Undo runs out', async () => {
  vi.useFakeTimers()
  const { wrapper, replace, remove, toasts, rows } = await mountInbox()
  try {
    expect(rows()).toContain('s-1')
    const thread = wrapper.getComponent(InboxPlanThread)
    expect(thread.findAll('button').some(b => b.text() === 'Close thread')).toBe(false)
    await thread.findAll('button').find(b => b.text() === 'Delete thread')!.trigger('click')
    await flushPromises()
    expect(rows()).not.toContain('s-1')
    expect(toasts.at(-1)?.title).toBe('Thread deleted · its drafts were discarded')
    expect(toasts.at(-1)?.actions?.[0]?.label).toBe('Undo')
    expect(replace).toHaveBeenCalledWith({ path: '/inbox/s-3', query: {} })
    expect(api.plan.close).not.toHaveBeenCalled()
    await vi.advanceTimersByTimeAsync(UNDO_MS)
    await flushPromises()
    expect(api.plan.close).toHaveBeenCalledWith('s-1')
    expect(remove).toHaveBeenCalledWith('s-1')
    expect(rows()).not.toContain('s-1')
  } finally {
    wrapper.unmount()
  }
})

it('deletes from a row, and Undo brings it back without closing', async () => {
  vi.useFakeTimers()
  const { wrapper, toasts, toastRemove, rows } = await mountInbox()
  try {
    const before = rows()
    const li = wrapper.findAll('li').find(li => li.find('[data-row="s-3"]').exists())!
    await li.findAll('button').find(b => b.text() === 'Delete thread')!.trigger('click')
    await flushPromises()
    expect(rows()).not.toContain('s-3')
    toasts.at(-1)!.actions![0]!.onClick()
    await flushPromises()
    expect(toastRemove).toHaveBeenCalled()
    expect(rows()).toEqual(before)
    await vi.advanceTimersByTimeAsync(UNDO_MS * 2)
    expect(api.plan.close).not.toHaveBeenCalled()
  } finally {
    wrapper.unmount()
  }
})
