// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/composables/useApi'
import { agents, inbox, projects, tasks } from '~/prototype/fixtures'
import InboxPage from '~/pages/inbox/[[itemId]].vue'

vi.mock('~/composables/useApi', () => ({
  api: {
    inbox: { get: vi.fn(), act: vi.fn() },
    tasks: { byRef: vi.fn(), evidence: vi.fn(), reviews: vi.fn() }
  }
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

const plain = vue.defineComponent({ setup: (_, { slots }) => () => vue.h('div', slots.default?.()) })
const composerStub = vue.defineComponent({
  name: 'PromptComposer',
  props: ['busy', 'disabled', 'submitLabel'],
  setup: () => () => vue.h('form')
})
const alertStub = vue.defineComponent({
  name: 'UAlert',
  props: ['title', 'actions'],
  setup: props => () => vue.h('div', { 'data-alert': true }, [props.title, ...(props.actions ?? []).map((a: { label: string, onClick: () => void }) => vue.h('button', { onClick: a.onClick }, a.label))])
})

async function mountInbox(type: 'human_review' | 'failed') {
  for (const name of ['ref', 'shallowRef', 'computed', 'watch', 'watchEffect', 'onMounted', 'onBeforeUnmount'] as const) vi.stubGlobal(name, vue[name])
  const item = inbox().needsYou.find(i => i.type === type)!
  const params = vue.reactive({ itemId: item.id })
  vi.stubGlobal('useRoute', () => ({ params }))
  vi.stubGlobal('useRouter', () => ({ replace: vi.fn(), push: vi.fn() }))
  vi.stubGlobal('useSeoMeta', vi.fn())
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  vi.stubGlobal('useMobileHeader', () => vue.ref(null))
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  vi.stubGlobal('usePlanThreadDelete', () => ({ pending: vue.ref([]), remove: vi.fn() }))
  vi.stubGlobal('useTaskFlyout', () => ({ ref: vue.ref(null), epic: vue.ref(null), open: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }))
  const listeners: ((event: { type: string }) => void)[] = []
  vi.stubGlobal('useLive', () => ({
    state: vue.ref({ agents, projects, loaded: true, runner: { online: true } }),
    subscribe: (listener: typeof listeners[number]) => {
      listeners.push(listener)
      return () => {}
    }
  }))
  vi.mocked(api.inbox.get).mockImplementation(async () => structuredClone(inbox()))
  vi.mocked(api.inbox.act).mockReset().mockResolvedValue({ task: null })
  vi.mocked(api.tasks.byRef).mockReset().mockRejectedValue(new Error('Server unavailable'))
  vi.mocked(api.tasks.evidence).mockResolvedValue([])
  vi.mocked(api.tasks.reviews).mockResolvedValue([])
  const wrapper = mount(InboxPage, { global: {
    components: { PromptComposer: composerStub, UAlert: alertStub, UDashboardPanel: plain },
    stubs: { UButton: true, UBadge: true, UInput: true, UTabs: true, UIcon: true, USkeleton: true, USelectMenu: true, MarkdownText: true, EvidenceList: true, TaskFlyout: true, AgentAvatar: true, ProjectThumbnail: true, PlanThreadRow: true, NuxtLink: true, InboxMobile: true }
  } })
  await flushPromises()
  const composer = () => wrapper.getComponent(composerStub)
  const submit = async () => {
    const sent = await (composer().vm.$attrs.onSubmit as (message: string) => Promise<boolean>)('')
    await flushPromises()
    return sent
  }
  const alert = () => wrapper.find('[data-alert]')
  return { wrapper, item, composer, submit, alert, refresh: () => listeners.forEach(l => l({ type: 'task.updated' })) }
}

it('shows the error instead of loading forever and keeps approval blocked when the task fails to load', async () => {
  const { wrapper, composer, submit, alert } = await mountInbox('human_review')
  try {
    expect(alert().text()).toContain('Couldn\'t load this task')
    expect(alert().find('button').text()).toBe('Retry')
    expect(composer().props('busy')).toBe(false)
    expect(composer().props('disabled')).toBe(true)
    expect(composer().props('submitLabel')).toBe('Task not loaded')
    expect(await submit()).toBe(false)
    expect(api.inbox.act).not.toHaveBeenCalled()
  } finally {
    wrapper.unmount()
  }
})

it('leaves the actions that do not need the task available after a failed load', async () => {
  const { wrapper, item, composer, submit } = await mountInbox('failed')
  try {
    expect(composer().props('busy')).toBe(false)
    expect(composer().props('disabled')).toBe(false)
    expect(await submit()).toBe(true)
    expect(api.inbox.act).toHaveBeenCalledWith((item as { taskId: string }).taskId, expect.objectContaining({ action: 'resolve' }))
  } finally {
    wrapper.unmount()
  }
})

it('recovers through Retry, and keeps the error while a live refresh fetches again', async () => {
  const { wrapper, item, composer, alert, refresh } = await mountInbox('human_review')
  try {
    refresh()
    await vue.nextTick()
    expect(alert().exists()).toBe(true)
    await flushPromises()
    expect(alert().exists()).toBe(true)
    const task = tasks.find(t => t.id === (item as { taskId: string }).taskId)!
    let finish = (_: typeof task) => {}
    vi.mocked(api.tasks.byRef).mockReturnValue(new Promise((resolve) => {
      finish = resolve
    }))
    await alert().find('button').trigger('click')
    expect(composer().props('busy')).toBe(true)
    expect(composer().props('submitLabel')).toBe('Loading task…')
    finish(task)
    await flushPromises()
    expect(alert().exists()).toBe(false)
    expect(composer().props('busy')).toBe(false)
    expect(composer().props('disabled')).toBe(false)
    expect(composer().props('submitLabel')).toMatch(/Approve and merge|Accept findings/)
  } finally {
    wrapper.unmount()
  }
})
