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
  vi.stubGlobal('useLive', () => ({
    state: vue.ref({ agents, projects, loaded: true, runner: { online: true } }),
    subscribe: () => () => {}
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
  const wrapper = mount(InboxPage, { global: { components: { InboxPlanThread, UDashboardPanel: plain, UButton: button, PlanThreadRow: row }, stubs: {
    UBadge: true, UInput: true, UTabs: true,
    AgentAvatar: true, MarkdownText: true, TaskFlyout: true,
    PlanConversation: true, InboxMobile: true, UAlert: true, USkeleton: true, NuxtLink: true,
    EvidenceList: true, USelectMenu: true, PromptComposer: true, UIcon: true, PlanQuestion: true, PlanDetail: true
  } } })
  await flushPromises()
  const rows = () => wrapper.findAll('[data-row]').map(r => r.attributes('data-row'))
  return { wrapper, replace, remove, toasts, toastRemove, rows }
}

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
