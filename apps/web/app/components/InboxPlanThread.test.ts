// @vitest-environment happy-dom
import type { ServerEvent } from '@corral/contracts'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/composables/useApi'
import { agents, inbox, planSessions, plans, projects } from '~/prototype/fixtures'
import InboxPlanThread from '~/components/InboxPlanThread.vue'
import InboxPage from '~/pages/inbox/[[itemId]].vue'

vi.mock('~/composables/useApi', () => ({
  api: { inbox: { get: vi.fn() }, plan: { session: vi.fn(), close: vi.fn() } }
}))

afterEach(() => vi.unstubAllGlobals())

it('advances from the original position when live removal precedes the close response', async () => {
  for (const name of ['ref', 'shallowRef', 'computed', 'watch', 'watchEffect', 'onMounted', 'onBeforeUnmount'] as const) vi.stubGlobal(name, vue[name])
  const listeners = new Set<(event: ServerEvent) => void>()
  const replace = vi.fn()
  const remove = vi.fn()
  const flyoutClose = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('useRoute', () => ({ params: { itemId: 's-1' } }))
  vi.stubGlobal('useRouter', () => ({ replace }))
  vi.stubGlobal('useSeoMeta', vi.fn())
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  vi.stubGlobal('useMobileHeader', () => vue.ref(null))
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  vi.stubGlobal('usePlanThreads', () => ({ remove }))
  vi.stubGlobal('useTaskFlyout', () => ({ ref: vue.ref(null), epic: vue.ref(null), plan: vue.ref(false), close: flyoutClose }))
  vi.stubGlobal('useLive', () => ({
    state: vue.ref({ agents, projects, loaded: true, runner: { online: true } }),
    subscribe: (listener: (event: ServerEvent) => void) => {
      listeners.add(listener)
      return () => listeners.delete(listener)
    }
  }))
  let data = inbox()
  const position = data.needsYou.findIndex(i => i.id === 's-1')
  expect(position).toBeGreaterThan(0)
  expect(data.needsYou[position + 1]?.id).toBe('s-3')
  vi.mocked(api.inbox.get).mockImplementation(async () => structuredClone(data))
  vi.mocked(api.plan.session).mockResolvedValue({ ...planSessions.find(s => s.id === 's-1')!, unread: false, messages: [], plans: plans['s-1']! })
  let finishClose!: () => void
  vi.mocked(api.plan.close).mockImplementation(() => new Promise((resolve) => {
    data = { ...data, needsYou: data.needsYou.filter(i => i.id !== 's-1'), count: data.count - 1 }
    // The server broadcasts removal before the HTTP request completes.
    for (const listener of listeners) listener({ type: 'plan.session', session: { ...planSessions.find(s => s.id === 's-1')!, closed: true, unread: false } })
    finishClose = () => resolve({ ...planSessions.find(s => s.id === 's-1')!, closed: true })
  }))
  const plain = vue.defineComponent({ name: 'Plain', setup: (_, { slots }) => () => vue.h('div', [slots.default?.(), slots.footer?.()]) })
  const button = vue.defineComponent({ props: ['label'], setup: props => () => vue.h('button', props.label) })
  const wrapper = mount(InboxPage, { global: { components: { InboxPlanThread, UDashboardPanel: plain, UButton: button, UModal: plain }, stubs: {
    UBadge: true, UInput: true, UTabs: true,
    AgentAvatar: true, PlanThreadRow: true, MarkdownText: true, TaskFlyout: true,
    PlanConversation: true, InboxMobile: true, UAlert: true, USkeleton: true, NuxtLink: true,
    EvidenceList: true, USelectMenu: true, PromptComposer: true, UIcon: true, PlanQuestion: true, PlanDetail: true
  } } })
  try {
    await flushPromises()
    expect(wrapper.html()).toContain('Design tasks')
    const thread = wrapper.getComponent(InboxPlanThread)
    const buttons = thread.findAll('button').filter(b => b.text() === 'Close thread')
    await buttons.at(-1)!.trigger('click')
    await flushPromises()
    expect(api.plan.close).toHaveBeenCalledWith('s-1')
    expect(replace).not.toHaveBeenCalled()
    finishClose()
    await flushPromises()
    expect(remove).toHaveBeenCalledWith('s-1')
    expect(flyoutClose).toHaveBeenCalled()
    expect(replace).toHaveBeenCalledWith('/inbox/s-3')
  } finally {
    wrapper.unmount()
  }
})
