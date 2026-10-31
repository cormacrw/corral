// @vitest-environment happy-dom
import type { InboxArtifact, ServerEvent } from '@corral/contracts'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/composables/useApi'
import { agents, inbox, projects, tasks } from '~/prototype/fixtures'
import { applyEvent, invalidateKeys } from '~/queries/dependencies'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'
import InboxReleaseNotes from '~/components/InboxReleaseNotes.vue'
import InboxPage from '~/pages/inbox/[[itemId]].vue'

vi.mock('~/composables/useApi', () => ({
  api: {
    inbox: { get: vi.fn(), act: vi.fn() },
    tasks: { byRef: vi.fn(), evidence: vi.fn(), reviews: vi.fn() },
    deployments: { read: vi.fn() }
  }
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

const plain = vue.defineComponent({ setup: (_, { slots }) => () => vue.h('div', slots.default?.()) })
const composerStub = vue.defineComponent({
  name: 'PromptComposer',
  props: ['busy', 'disabled', 'submitLabel', 'modelValue'],
  emits: ['update:modelValue'],
  setup: () => () => vue.h('form')
})
const alertStub = vue.defineComponent({
  name: 'UAlert',
  props: ['title', 'actions'],
  setup: props => () => vue.h('div', { 'data-alert': true }, [props.title, ...(props.actions ?? []).map((a: { label: string, onClick: () => void }) => vue.h('button', { onClick: a.onClick }, a.label))])
})

async function mountInbox(type: 'human_review' | 'failed', taskRef?: string, dockedTask: string | null = null, selection = true) {
  for (const name of ['ref', 'shallowRef', 'computed', 'watch', 'watchEffect', 'onMounted', 'onBeforeUnmount'] as const) vi.stubGlobal(name, vue[name])
  const item = inbox().needsYou.find(i => i.type === type && (taskRef ? i.taskRef === taskRef : tasks.find(t => t.id === i.taskId)?.type !== 'design'))!
  const params = vue.reactive<{ itemId?: string }>({ itemId: selection ? item.id : undefined })
  vi.stubGlobal('useRoute', () => ({ params }))
  const router = {
    replace: vi.fn(async ({ path }: { path: string }) => {
      params.itemId = path.split('/')[2]
    }),
    push: vi.fn()
  }
  vi.stubGlobal('useRouter', () => router)
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useSeoMeta', vi.fn())
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  vi.stubGlobal('useMobileHeader', () => vue.ref(null))
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  vi.stubGlobal('usePlanThreadDelete', () => ({ pending: vue.ref([]), remove: vi.fn() }))
  const closeFlyout = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('useTaskFlyout', () => ({ ref: vue.ref(dockedTask), epic: vue.ref(null), open: vi.fn(), close: closeFlyout }))
  vi.stubGlobal('useLive', () => ({ state: vue.ref({ agents, projects, loaded: true, runner: { online: true } }) }))
  vi.mocked(api.inbox.get).mockImplementation(async () => structuredClone(inbox()))
  vi.mocked(api.inbox.act).mockReset().mockResolvedValue({ task: null })
  const byRef = vi.mocked(api.tasks.byRef).mockReset()
  if (taskRef) byRef.mockResolvedValue(tasks.find(t => t.ref === taskRef)!)
  else byRef.mockRejectedValue(new Error('Server unavailable'))
  vi.mocked(api.tasks.evidence).mockResolvedValue([])
  vi.mocked(api.tasks.reviews).mockResolvedValue([])
  const client = testQueryClient()
  const wrapper = mount(InboxPage, { global: {
    plugins: [[VueQueryPlugin, { queryClient: client }]],
    components: { InboxReleaseNotes, PromptComposer: composerStub, UAlert: alertStub, UDashboardPanel: plain },
    stubs: { InboxReleaseNotes: false, UAlert: false, UModal: true, UButton: true, UBadge: true, UInput: true, UTabs: true, UIcon: true, USkeleton: true, USelectMenu: true, MarkdownText: true, EvidenceList: true, TaskFlyout: true, AgentAvatar: true, ProjectThumbnail: true, PlanThreadRow: true, NuxtLink: true, InboxMobile: true }
  } })
  await flushPromises()
  const composer = () => wrapper.getComponent(composerStub)
  const submit = async () => {
    const sent = await (composer().vm.$attrs.onSubmit as (message: string) => Promise<boolean>)('')
    await flushPromises()
    return sent
  }
  const alert = () => wrapper.find('[data-alert]')
  return { wrapper, item, params, replace: router.replace, close: closeFlyout, composer, submit, alert, router, closeFlyout, emitLive: (event: unknown) => invalidateKeys(client, applyEvent(client, event as ServerEvent)), refresh: () => invalidateKeys(client, [keys.inbox()]) }
}

it('keeps the dock when an action moves on to the next task, even if the item left the list first', async () => {
  const { wrapper, item, replace, close, submit, refresh } = await mountInbox('failed', undefined, 'COR-1')
  try {
    const next = inbox().needsYou.find(i => i.taskRef && i.id !== item.id)!
    let finish = (_: { task: null }) => {}
    vi.mocked(api.inbox.act).mockReturnValue(new Promise((resolve) => {
      finish = resolve
    }))
    vi.mocked(api.inbox.get).mockImplementation(async () => ({ ...inbox(), needsYou: [next], resolved: [], activity: [] }))
    close.mockClear()
    const sending = submit()
    // The live update of the task usually beats the action's response
    void refresh()
    await flushPromises()
    finish({ task: null })
    await sending
    expect(close).not.toHaveBeenCalled()
    expect(replace).toHaveBeenCalledWith({ path: `/inbox/${next.id}`, query: { task: next.taskRef } })
  } finally {
    wrapper.unmount()
  }
})

it('closes the dock when the item left the list and its action failed', async () => {
  const { wrapper, item, close, submit, refresh } = await mountInbox('failed', undefined, 'COR-1')
  try {
    let fail = (_: Error) => {}
    vi.mocked(api.inbox.act).mockReturnValue(new Promise((_, reject) => {
      fail = reject
    }))
    vi.mocked(api.inbox.get).mockImplementation(async () => ({ ...inbox(), needsYou: inbox().needsYou.filter(i => i.id !== item.id), resolved: [], activity: [] }))
    close.mockClear()
    const sending = submit()
    void refresh()
    await flushPromises()
    expect(close).not.toHaveBeenCalled()
    fail(new Error('Conflict'))
    expect(await sending).toBe(false)
    await flushPromises()
    expect(close).toHaveBeenCalledOnce()
  } finally {
    wrapper.unmount()
  }
})

it('opens the empty state without a task once the last item is resolved', async () => {
  const { wrapper, replace, submit } = await mountInbox('failed', undefined, 'COR-1')
  try {
    vi.mocked(api.inbox.get).mockImplementation(async () => ({ ...inbox(), needsYou: [], resolved: [], activity: [] }))
    await submit()
    expect(replace).toHaveBeenCalledWith({ path: '/inbox', query: {} })
  } finally {
    wrapper.unmount()
  }
})

it('keeps a shared dock open on /inbox with nothing selected', async () => {
  const { wrapper, close, refresh } = await mountInbox('failed', undefined, 'COR-1', false)
  try {
    await refresh()
    await flushPromises()
    expect(close).not.toHaveBeenCalled()
  } finally {
    wrapper.unmount()
  }
})

it('leaves a newer selection alone when one is made while the next task loads', async () => {
  const { wrapper, item, params, replace, submit } = await mountInbox('failed')
  try {
    const remaining = { ...inbox(), needsYou: inbox().needsYou.filter(i => i.id !== item.id) }
    vi.mocked(api.inbox.get).mockImplementation(async () => structuredClone(remaining))
    let finish = (_: never) => {}
    vi.mocked(api.tasks.byRef).mockReturnValue(new Promise((resolve) => {
      finish = resolve as never
    }))
    const sending = submit()
    await flushPromises()
    const picked = remaining.needsYou[0]!
    params.itemId = picked.id
    await flushPromises()
    finish(tasks[0] as never)
    await sending
    expect(replace).not.toHaveBeenCalled()
    expect(params.itemId).toBe(picked.id)
  } finally {
    wrapper.unmount()
  }
})

it('moves on without waiting out a next task that won\'t load', async () => {
  const { wrapper, item, replace, submit } = await mountInbox('failed')
  try {
    const remaining = { ...inbox(), needsYou: inbox().needsYou.filter(i => i.id !== item.id) }
    vi.mocked(api.inbox.get).mockImplementation(async () => structuredClone(remaining))
    vi.mocked(api.tasks.byRef).mockReturnValue(new Promise(() => {}))
    await submit()
    await vi.waitFor(() => expect(replace).toHaveBeenCalledOnce(), { timeout: 2000 })
  } finally {
    wrapper.unmount()
  }
})

it('opens the next item at the top of a new detail scroller', async () => {
  const { wrapper, item, params } = await mountInbox('human_review')
  try {
    const next = inbox().needsYou.find(i => i.type === 'failed')!
    const scroller = wrapper.get('[data-testid="inbox-detail-scroller"]').element
    scroller.scrollTop = 2000
    params.itemId = next.id
    await flushPromises()
    expect(next.id).not.toBe(item.id)
    expect(wrapper.get('[data-testid="inbox-detail-scroller"]').element).not.toBe(scroller)
    expect(wrapper.get('[data-testid="inbox-detail-scroller"]').element.scrollTop).toBe(0)
  } finally {
    wrapper.unmount()
  }
})

it('clears a release note\'s dot before the request, without fetching the Inbox', async () => {
  const { wrapper, params, emitLive } = await mountInbox('human_review')
  try {
    const note = inbox().needsYou.find(i => i.type === 'release_notes')!
    vi.mocked(api.inbox.get).mockClear()
    let finish = () => {}
    vi.mocked(api.deployments.read).mockReturnValue(new Promise((resolve) => {
      finish = () => resolve({} as never)
    }))
    params.itemId = note.id
    await flushPromises()
    expect(api.deployments.read).toHaveBeenCalledWith(note.id)
    expect(wrapper.find('[aria-label="Unread"]').exists()).toBe(false)
    finish()
    await flushPromises()
    await emitLive({ type: 'deployment.updated', deployment: { id: note.id }, markedRead: true })
    await flushPromises()
    expect(api.inbox.get).not.toHaveBeenCalled()
    // Any other change to a deployment still reloads the list
    await emitLive({ type: 'deployment.updated', deployment: { id: note.id } })
    expect(api.inbox.get).toHaveBeenCalledOnce()
  } finally {
    wrapper.unmount()
  }
})

it('fills in a pending release note when its deployment updates', async () => {
  const { wrapper, params, emitLive } = await mountInbox('human_review')
  try {
    const note = inbox().needsYou.find(i => i.type === 'release_notes')!
    const withNote = (notesStatus: string, notes: string | null) => ({ ...inbox(), needsYou: inbox().needsYou.map(i => i.id === note.id ? { ...i, notesStatus, notes } : i) })
    vi.mocked(api.inbox.get).mockImplementation(async () => withNote('pending', null) as never)
    await emitLive({ type: 'deployment.updated', deployment: { id: note.id } })
    params.itemId = note.id
    await flushPromises()
    expect(wrapper.text()).toContain('Writing release notes…')
    vi.mocked(api.inbox.get).mockImplementation(async () => withNote('ready', 'What shipped') as never)
    await emitLive({ type: 'deployment.updated', deployment: { id: note.id } })
    await flushPromises()
    expect(wrapper.text()).not.toContain('Writing release notes…')
  } finally {
    wrapper.unmount()
  }
})

it('holds the list while an action runs, then moves to the item at the same position', async () => {
  const { wrapper, item, params, replace, submit, refresh } = await mountInbox('failed')
  try {
    const before = inbox().needsYou
    const position = before.findIndex(i => i.id === item.id)
    let finish = (_: { task: null }) => {}
    vi.mocked(api.inbox.act).mockReturnValue(new Promise((resolve) => {
      finish = resolve
    }))
    const sending = submit()
    // The server drops the item and a row above it before the response lands
    const remaining = { ...inbox(), needsYou: before.filter((i, index) => i.id !== item.id && index !== 0) }
    vi.mocked(api.inbox.get).mockImplementation(async () => structuredClone(remaining))
    await refresh()
    await flushPromises()
    expect(params.itemId).toBe(item.id)
    expect(wrapper.find('[data-testid="inbox-detail-scroller"]').exists()).toBe(true)
    expect(wrapper.find('usskeleton-stub, u-skeleton-stub').exists()).toBe(false)
    expect(replace).not.toHaveBeenCalled()
    finish({ task: null })
    await sending
    const next = remaining.needsYou[Math.min(position, remaining.needsYou.length - 1)]!
    expect(replace).toHaveBeenCalledExactlyOnceWith({ path: `/inbox/${next.id}`, query: {} })
  } finally {
    wrapper.unmount()
  }
})

it('lets go of the held list when the action fails, keeping the draft', async () => {
  const { wrapper, item, composer, replace, submit, refresh, alert } = await mountInbox('failed')
  try {
    vi.mocked(api.inbox.act).mockRejectedValue(new Error('Conflict'))
    await (composer().vm.$emit('update:modelValue', 'my note'), vue.nextTick())
    expect(await submit()).toBe(false)
    expect(alert().text()).toContain('Conflict')
    expect(composer().props('modelValue')).toBe('my note')
    await refresh()
    await flushPromises()
    expect(wrapper.find('[data-testid="inbox-detail-scroller"]').exists()).toBe(true)
    expect(replace).not.toHaveBeenCalled()
    expect(item.id).toBeTruthy()
  } finally {
    wrapper.unmount()
  }
})

it('shows a revisited item\'s task at once from cache', async () => {
  const { wrapper, item, params, composer } = await mountInbox('human_review', 'COR-41')
  try {
    expect(composer().props('submitLabel')).toBe('Approve design')
    const other = inbox().needsYou.find(i => i.type === 'failed')!
    params.itemId = other.id
    await flushPromises()
    vi.mocked(api.tasks.byRef).mockClear()
    vi.mocked(api.tasks.byRef).mockReturnValue(new Promise(() => {}))
    params.itemId = item.id
    await vue.nextTick()
    await vue.nextTick()
    expect(composer().props('submitLabel')).toBe('Approve design')
    expect(composer().props('busy')).toBe(false)
  } finally {
    wrapper.unmount()
  }
})

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

it('loads evidence for a non-review item only when it has new artifacts', async () => {
  const failed = inbox().needsYou.find(i => i.type === 'failed' && i.taskRef)!
  const { wrapper, item, refresh } = await mountInbox('failed', failed.taskRef!)
  try {
    const withArtifacts = (newArtifacts: InboxArtifact[]) => {
      const data = inbox()
      const needsYou = data.needsYou.map(i => i.id === item.id ? { ...i, newArtifacts } : i)
      vi.mocked(api.inbox.get).mockImplementation(async () => ({ ...data, needsYou }))
    }
    withArtifacts([])
    refresh()
    await flushPromises()
    vi.mocked(api.tasks.evidence).mockClear()
    vi.mocked(api.tasks.reviews).mockClear()
    withArtifacts([{ id: 'e1', kind: 'other', name: 'report.html', url: '/api/evidence/e1/file', taskRef: null, at: item.at }])
    refresh()
    await flushPromises()
    expect(api.tasks.evidence).toHaveBeenCalled()
    expect(api.tasks.reviews).not.toHaveBeenCalled()
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

it('offers Approve design once the loaded task is a design', async () => {
  const { wrapper, item, composer, submit } = await mountInbox('human_review', 'COR-41')
  try {
    expect(composer().props('submitLabel')).toBe('Approve design')
    await submit()
    expect(api.inbox.act).toHaveBeenCalledWith((item as { taskId: string }).taskId, expect.objectContaining({ action: 'approve' }))
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

it('labels a design approval and advances without a live refresh closing the flyout', async () => {
  const { wrapper, item, composer, submit, alert, router, closeFlyout, refresh } = await mountInbox('human_review')
  try {
    const original = tasks.find(t => t.id === (item as { taskId: string }).taskId)!
    vi.mocked(api.tasks.byRef).mockResolvedValue({ ...original, type: 'design', acceptanceCriteria: [] })
    await alert().find('button').trigger('click')
    await flushPromises()
    expect(composer().props('submitLabel')).toBe('Approve design')
    closeFlyout.mockClear()
    const remaining = structuredClone(inbox())
    remaining.needsYou = remaining.needsYou.filter(i => i.id !== item.id)
    vi.mocked(api.inbox.get).mockResolvedValue(remaining)
    const sent = submit()
    refresh()
    expect(await sent).toBe(true)
    expect(closeFlyout).not.toHaveBeenCalled()
    const position = inbox().needsYou.findIndex(i => i.id === item.id)
    const next = remaining.needsYou[Math.min(position, remaining.needsYou.length - 1)]!
    expect(router.replace).toHaveBeenCalledWith({ path: `/inbox/${next.id}`, query: {} })
  } finally {
    wrapper.unmount()
  }
})
