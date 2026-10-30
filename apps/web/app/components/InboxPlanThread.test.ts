// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/composables/useApi'
import { agents, inbox, planSessions, plans, projects } from '~/prototype/fixtures'
import InboxPlanThread from '~/components/InboxPlanThread.vue'
import InboxPage from '~/pages/inbox/[[itemId]].vue'
import { UNDO_MS, usePlanThreadDelete } from '~/composables/usePlanThreadDelete'

vi.mock('~/composables/useApi', () => ({
  api: { inbox: { get: vi.fn() }, plan: { session: vi.fn(), close: vi.fn() } }
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
  vi.stubGlobal('useSeoMeta', vi.fn())
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  vi.stubGlobal('useMobileHeader', () => vue.ref(null))
  vi.stubGlobal('useToast', () => ({ add: (t: typeof toasts[number]) => (toasts.push(t), { id: toasts.length }), remove: toastRemove }))
  vi.stubGlobal('usePlanThreads', () => ({ add: vi.fn(), remove }))
  vi.stubGlobal('usePlanThreadDelete', usePlanThreadDelete)
  vi.stubGlobal('useTaskFlyout', () => ({ ref: vue.ref(null), epic: vue.ref(null), plan: vue.ref(false), close: vi.fn().mockResolvedValue(undefined) }))
  const listeners: ((event: { type: string }) => void)[] = []
  vi.stubGlobal('useLive', () => ({
    state: vue.ref({ agents, projects, loaded: true, runner: { online: true } }),
    subscribe: (listener: typeof listeners[number]) => {
      listeners.push(listener)
      return () => {}
    }
  }))
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
  const wrapper = mount(InboxPage, { global: { components: { InboxPlanThread, UDashboardPanel: plain, UButton: button, PlanThreadRow: row, AgentAvatar: avatar }, stubs: {
    UBadge: true, UInput: true, UTabs: true,
    MarkdownText: true, TaskFlyout: true,
    PlanConversation: true, InboxMobile: true, UAlert: true, USkeleton: true, NuxtLink: true,
    EvidenceList: true, USelectMenu: true, PromptComposer: true, UIcon: true, PlanQuestion: true, PlanDetail: true
  } } })
  await flushPromises()
  const rows = () => wrapper.findAll('[data-row]').map(r => r.attributes('data-row'))
  const rename = (name: string) => {
    data = { ...data, needsYou: data.needsYou.map(i => i.type === 'plan_thread' ? { ...i, sender: { ...i.sender, name } } : i) }
    for (const listener of listeners) listener({ type: 'agent.updated' })
  }
  return { wrapper, replace, remove, toasts, toastRemove, rows, rename }
}

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
    expect(replace).toHaveBeenCalledWith('/inbox/s-3')
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
