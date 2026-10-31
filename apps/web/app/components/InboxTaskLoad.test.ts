// @vitest-environment happy-dom
import type { InboxActionInput, InboxArtifact, ServerEvent } from '@corral/contracts'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, describe, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/composables/useApi'
import { agents, inbox, projects, pullRequestDetails, tasks } from '~/prototype/fixtures'
import { applyEvent, invalidateKeys } from '~/queries/dependencies'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'
import PromptComposer from '~/components/PromptComposer.vue'
import InboxPanel from '~/components/InboxPanel.vue'
import InboxPanelActions from '~/components/InboxPanelActions.vue'
import InboxPanelArtifacts from '~/components/InboxPanelArtifacts.vue'
import InboxPanelDetails from '~/components/InboxPanelDetails.vue'
import InboxMobileItem from '~/components/InboxMobileItem.vue'
import InboxPanelDiff from '~/components/InboxPanelDiff.vue'
import InboxPanelMeta from '~/components/InboxPanelMeta.vue'
import InboxPanelThumbBar from '~/components/InboxPanelThumbBar.vue'
import InboxPanelTray from '~/components/InboxPanelTray.vue'
import InboxPanelVerdict from '~/components/InboxPanelVerdict.vue'
import InboxReleaseNotes from '~/components/InboxReleaseNotes.vue'
import type { InboxPanelContext } from '~/composables/useInboxPanel'
import InboxPage from '~/pages/inbox.vue'
import InboxItemPage from '~/pages/inbox/[itemId].vue'

vi.mock('~/composables/useApi', () => ({
  api: {
    inbox: { get: vi.fn(), act: vi.fn() },
    projects: { pullRequest: vi.fn() },
    tasks: { byRef: vi.fn(), evidence: vi.fn(), reviews: vi.fn(), designs: vi.fn(), comment: vi.fn() },
    deployments: { read: vi.fn() },
    attachments: { upload: vi.fn() }
  }
}))

afterEach(() => {
  vi.unstubAllGlobals()
})

const plain = vue.defineComponent({ setup: (_, { slots }) => () => vue.h('div', slots.default?.()) })
const composerStub = vue.defineComponent({
  name: 'PromptComposer',
  props: ['busy', 'disabled', 'submitLabel', 'modelValue', 'placeholder', 'allowEmpty', 'onSubmit'],
  emits: ['update:modelValue'],
  setup: (props, { expose }) => {
    expose({ focus: vi.fn(), send: () => props.onSubmit(props.modelValue) })
    return () => vue.h('form')
  }
})
const buttonStub = vue.defineComponent({
  name: 'UButton',
  inheritAttrs: false,
  props: ['label', 'disabled', 'to', 'ariaLabel'],
  setup: (props, { attrs }) => () => vue.h(props.to ? 'a' : 'button', { ...attrs, disabled: props.disabled, href: props.to }, props.label ?? attrs['aria-label'] as string)
})
const tabsStub = vue.defineComponent({
  name: 'UTabs',
  props: ['items'],
  emits: ['update:modelValue'],
  setup: (props, { emit }) => () => vue.h('div', (props.items as { label: string, value: string }[]).map(tab => vue.h('button', { 'data-tab': tab.value, 'onClick': () => emit('update:modelValue', tab.value) }, tab.label)))
})
const evidenceStub = vue.defineComponent({
  name: 'EvidenceList',
  props: ['checked'],
  emits: ['update:checked'],
  setup: () => () => vue.h('div')
})
const alertStub = vue.defineComponent({
  name: 'UAlert',
  props: ['title', 'actions'],
  setup: props => () => vue.h('div', { 'data-alert': true }, [props.title, ...(props.actions ?? []).map((a: { label: string, onClick: () => void }) => vue.h('button', { onClick: a.onClick }, a.label))])
})

async function mountInbox(type: 'human_review' | 'failed' | 'question', taskRef?: string, dockedTask: string | null = null, selection = true, editTask = (task: (typeof tasks)[number]) => task, realComposer = false, mobile = false, editApi = () => {}) {
  for (const name of ['ref', 'shallowRef', 'computed', 'watch', 'watchEffect', 'onMounted', 'onBeforeUnmount', 'nextTick'] as const) vi.stubGlobal(name, vue[name])
  const fixture = inbox()
  if (type === 'question') {
    const question = fixture.needsYou.find(i => i.taskRef === 'COR-8')!
    question.type = 'question'
  }
  const item = fixture.needsYou.find(i => i.type === type && (taskRef ? i.taskRef === taskRef : tasks.find(t => t.id === i.taskId)?.type !== 'design'))!
  const params = vue.reactive<{ itemId?: string }>({ itemId: selection ? item.id : undefined })
  vi.stubGlobal('useRoute', () => ({ params }))
  const router = {
    replace: vi.fn(async ({ path }: { path: string }) => {
      params.itemId = path.split('/')[2]
    }),
    push: vi.fn(),
    resolve: (path: string) => ({ href: path })
  }
  vi.stubGlobal('useRouter', () => router)
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useSeoMeta', vi.fn())
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(mobile) }))
  vi.stubGlobal('useMobileHeader', () => vue.ref(null))
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  vi.stubGlobal('usePlanThreadDelete', () => ({ pending: vue.ref([]), remove: vi.fn() }))
  const closeFlyout = vi.fn().mockResolvedValue(undefined)
  vi.stubGlobal('useTaskFlyout', () => ({ ref: vue.ref(dockedTask), epic: vue.ref(null), open: vi.fn(), close: closeFlyout }))
  vi.stubGlobal('useShell', () => ({ agents, projects, loaded: true, runner: { online: true } }))
  vi.mocked(api.inbox.get).mockImplementation(async () => structuredClone(fixture))
  vi.mocked(api.inbox.act).mockReset().mockResolvedValue({ task: null })
  const byRef = vi.mocked(api.tasks.byRef).mockReset()
  if (taskRef) byRef.mockResolvedValue(editTask(tasks.find(t => t.ref === taskRef)!))
  else byRef.mockRejectedValue(new Error('Server unavailable'))
  vi.mocked(api.tasks.evidence).mockResolvedValue([])
  vi.mocked(api.tasks.reviews).mockResolvedValue([])
  vi.mocked(api.tasks.designs).mockResolvedValue([])
  vi.mocked(api.projects.pullRequest).mockReset().mockResolvedValue(pullRequestDetails[0]!)
  editApi()
  const client = testQueryClient()
  // As Nuxt renders the child: keyed by its path
  const NuxtPage = vue.defineComponent({ setup: () => () => params.itemId ? vue.h(InboxItemPage, { key: params.itemId }) : null })
  const wrapper = mount(InboxPage, { global: {
    plugins: [[VueQueryPlugin, { queryClient: client }]],
    components: { NuxtPage, InboxPanel, ...(mobile && { InboxMobileItem, MobilePageHeader: plain }), InboxPanelThumbBar, InboxPanelActions, InboxPanelArtifacts, InboxPanelDetails, InboxPanelDiff, InboxPanelMeta, InboxPanelTray, InboxPanelVerdict, InboxReleaseNotes, EvidenceList: evidenceStub, PromptComposer: realComposer ? PromptComposer : composerStub, UChatPrompt: vue.defineComponent({ setup: (_, { slots }) => () => vue.h('div', [slots.header?.(), slots.footer?.()]) }), UAlert: alertStub, UButton: buttonStub, UTabs: tabsStub, UDashboardPanel: plain },
    stubs: { UModal: true, EvidenceViewer: true, InboxMessage: true, InboxDesignReviewLink: true, UBadge: true, UInput: true, UIcon: true, USkeleton: true, USelectMenu: true, MarkdownText: true, TaskFlyout: true, AgentAvatar: true, ProjectThumbnail: true, PlanThreadRow: true, NuxtLink: true, InboxMobile: true, ...(!mobile && { InboxMobileItem: true }) }
  } })
  await flushPromises()
  const composer = () => wrapper.getComponent(composerStub)
  const panel = () => wrapper.getComponent(InboxPanel).props('ctx') as InboxPanelContext
  const primary = () => wrapper.get('[data-testid="inbox-primary"]')
  // Clicks past a disabled button, to prove the action guards itself too
  const submit = async () => {
    const sent = await panel().act(panel().actions[0]!.value as InboxActionInput['action'])
    await flushPromises()
    return sent
  }
  const openTab = (value: string) => wrapper.get(`[data-tab="${value}"]`).trigger('click')
  const alert = () => wrapper.find('[data-alert]')
  return { wrapper, item, params, panel, primary, openTab, replace: router.replace, close: closeFlyout, composer, submit, alert, router, closeFlyout, emitLive: (event: unknown) => invalidateKeys(client, applyEvent(client, event as ServerEvent)), refresh: () => invalidateKeys(client, [keys.inbox()]) }
}

it('moves on to the next task with the flyout closed, even if the item left the list first', async () => {
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
    expect(replace).toHaveBeenCalledWith({ path: `/inbox/${next.id}`, query: {} })
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

it('resets the draft and checked criteria between items, and has neither after Back', async () => {
  const { wrapper, item, params, composer, openTab } = await mountInbox('human_review', 'COR-5')
  try {
    const evidence = () => wrapper.getComponent(evidenceStub)
    await openTab('criteria')
    await (composer().vm.$emit('update:modelValue', 'my note'), vue.nextTick())
    evidence().vm.$emit('update:checked', ['c1'])
    await vue.nextTick()
    expect(evidence().props('checked')).toEqual(['c1'])
    const other = inbox().needsYou.find(i => i.type === 'failed')!
    params.itemId = other.id
    await flushPromises()
    expect(composer().props('modelValue')).toBe('')
    params.itemId = item.id
    await flushPromises()
    expect(composer().props('modelValue')).toBe('')
    await openTab('criteria')
    expect(evidence().props('checked')).toEqual([])
    await (composer().vm.$emit('update:modelValue', 'my note'), vue.nextTick())
    params.itemId = undefined
    await flushPromises()
    params.itemId = item.id
    await flushPromises()
    expect(composer().props('modelValue')).toBe('')
  } finally {
    wrapper.unmount()
  }
})

it('keeps the list mounted while the selection changes', async () => {
  const { wrapper, params } = await mountInbox('human_review')
  try {
    const list = wrapper.get('ul').element
    params.itemId = inbox().needsYou.find(i => i.type === 'failed')!.id
    await flushPromises()
    params.itemId = undefined
    await flushPromises()
    expect(wrapper.get('ul').element).toBe(list)
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
  const { wrapper, item, composer, replace, submit, refresh } = await mountInbox('failed')
  try {
    vi.mocked(api.inbox.act).mockRejectedValue(new Error('Conflict'))
    await (composer().vm.$emit('update:modelValue', 'my note'), vue.nextTick())
    expect(await submit()).toBe(false)
    expect(wrapper.findAll('[data-alert]').at(-1)!.text()).toContain('Conflict')
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
  const { wrapper, item, params, primary, composer } = await mountInbox('human_review', 'COR-41')
  try {
    expect(primary().text()).toBe('Approve design')
    const other = inbox().needsYou.find(i => i.type === 'failed')!
    params.itemId = other.id
    await flushPromises()
    vi.mocked(api.tasks.byRef).mockClear()
    vi.mocked(api.tasks.byRef).mockReturnValue(new Promise(() => {}))
    params.itemId = item.id
    await vue.nextTick()
    await vue.nextTick()
    expect(primary().text()).toBe('Approve design')
    expect(composer().props('busy')).toBe(false)
  } finally {
    wrapper.unmount()
  }
})

it('shows the error instead of loading forever and keeps approval blocked when the task fails to load', async () => {
  const { wrapper, composer, primary, submit, alert } = await mountInbox('human_review')
  try {
    expect(alert().text()).toContain('Couldn\'t load this task')
    expect(alert().find('button').text()).toBe('Retry')
    expect(composer().props('busy')).toBe(false)
    expect(primary().text()).toBe('Task not loaded')
    expect(primary().attributes('disabled')).toBeDefined()
    expect(wrapper.findAll('[data-testid="inbox-actions"] button').find(b => b.text() === 'Request changes')!.attributes('disabled')).toBeUndefined()
    expect(wrapper.find('[data-testid="inbox-overview-loading"]').exists()).toBe(false)
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
    vi.mocked(api.tasks.evidence).mockResolvedValue([
      { id: 'e1', kind: 'screenshot', fileName: 'screen.png', contentType: 'image/png', url: '/api/evidence/e1/file' },
      { id: 'e2', kind: 'other', fileName: 'report.html', contentType: 'text/html', url: '/api/evidence/e2/file' }
    ] as never)
    withArtifacts([{ id: 'e1', kind: 'other', name: 'report.html', url: '/api/evidence/e1/file', taskRef: null, at: item.at }])
    refresh()
    await flushPromises()
    expect(api.tasks.evidence).toHaveBeenCalled()
    expect(api.tasks.reviews).not.toHaveBeenCalled()
    const overview = wrapper.get('[data-testid="inbox-detail-scroller"]')
    expect(overview.find('img').exists()).toBe(false)
    expect(overview.text()).not.toContain('report.html')
    expect(overview.get('[data-testid="inbox-action-help"]').text()).toContain('Retry')
  } finally {
    wrapper.unmount()
  }
})

it('leaves the actions that do not need the task available after a failed load', async () => {
  const { wrapper, item, composer, primary, submit } = await mountInbox('failed')
  try {
    expect(composer().props('busy')).toBe(false)
    expect(primary().attributes('disabled')).toBeUndefined()
    expect(await submit()).toBe(true)
    expect(api.inbox.act).toHaveBeenCalledWith((item as { taskId: string }).taskId, expect.objectContaining({ action: 'resolve' }))
  } finally {
    wrapper.unmount()
  }
})

it('offers Approve design once the loaded task is a design', async () => {
  const { wrapper, item, primary } = await mountInbox('human_review', 'COR-41')
  try {
    expect(primary().text()).toBe('Approve design')
    await primary().trigger('click')
    await flushPromises()
    expect(api.inbox.act).toHaveBeenCalledWith((item as { taskId: string }).taskId, expect.objectContaining({ action: 'approve' }))
  } finally {
    wrapper.unmount()
  }
})

it('recovers through Retry, and keeps the error while a live refresh fetches again', async () => {
  const { wrapper, item, primary, alert, refresh } = await mountInbox('human_review')
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
    expect(primary().text()).toBe('Loading task…')
    expect(primary().attributes('disabled')).toBeDefined()
    expect(wrapper.find('[data-testid="inbox-overview-loading"]').exists()).toBe(true)
    finish(task)
    await flushPromises()
    expect(alert().exists()).toBe(false)
    expect(primary().attributes('disabled')).toBeUndefined()
    expect(primary().text()).toMatch(/Approve and merge|Accept findings/)
  } finally {
    wrapper.unmount()
  }
})

it('labels a design approval and advances without a live refresh closing the flyout', async () => {
  const { wrapper, item, primary, submit, alert, router, closeFlyout, refresh } = await mountInbox('human_review')
  try {
    const original = tasks.find(t => t.id === (item as { taskId: string }).taskId)!
    vi.mocked(api.tasks.byRef).mockResolvedValue({ ...original, type: 'design', acceptanceCriteria: [] })
    await alert().find('button').trigger('click')
    await flushPromises()
    expect(primary().text()).toBe('Approve design')
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

it('shows PR description and Code diff N on a code review, counting every changed file', async () => {
  const { wrapper, openTab } = await mountInbox('human_review', 'COR-5')
  try {
    expect(api.projects.pullRequest).toHaveBeenCalledWith('corral', 64)
    vi.mocked(api.projects.pullRequest).mockClear()
    expect(wrapper.get('[data-tab="diff"]').text()).toBe(`Code diff ${pullRequestDetails[0]!.totalFiles}`)
    await openTab('pr')
    expect(wrapper.get('[data-testid="inbox-pr-description"]').text()).toContain('#64')
    await openTab('diff')
    expect(wrapper.findAll('[data-testid="inbox-diff-file"]')).toHaveLength(pullRequestDetails[0]!.files.length)
    expect(api.projects.pullRequest).not.toHaveBeenCalled()
  } finally {
    wrapper.unmount()
  }
})

it.each([
  ['a design', 'design'],
  ['a spike', 'spike']
] as const)('shows neither PR tab on %s, even with a PR', async (_, type) => {
  const { wrapper } = await mountInbox('human_review', 'COR-5', null, true, task => ({ ...task, type }))
  try {
    expect(wrapper.find('[data-tab="overview"]').exists()).toBe(true)
    expect(wrapper.find('[data-tab="pr"]').exists()).toBe(false)
    expect(wrapper.find('[data-tab="diff"]').exists()).toBe(false)
    expect(api.projects.pullRequest).not.toHaveBeenCalled()
  } finally {
    wrapper.unmount()
  }
})

it('shows neither PR tab on an item without a PR', async () => {
  const item = inbox().needsYou.find(i => i.type === 'failed' && !i.prUrl)!
  const { wrapper } = await mountInbox('failed', item.taskRef!)
  try {
    expect(wrapper.find('[data-tab="overview"]').exists()).toBe(true)
    expect(wrapper.find('[data-tab="pr"]').exists()).toBe(false)
    expect(wrapper.find('[data-tab="diff"]').exists()).toBe(false)
    expect(api.projects.pullRequest).not.toHaveBeenCalled()
  } finally {
    wrapper.unmount()
  }
})

it('shows the error and Retry in the PR tabs with the rest of the panel working', async () => {
  const { wrapper, item, primary, openTab, alert } = await mountInbox('human_review', 'COR-5', null, true, task => task, false, false, () => {
    vi.mocked(api.projects.pullRequest).mockRejectedValue(new Error('GitHub couldn\'t return PR #64'))
  })
  try {
    expect(wrapper.get('[data-tab="diff"]').text()).toBe('Code diff')
    await openTab('diff')
    expect(alert().text()).toContain('Couldn\'t load this pull request')
    await openTab('pr')
    expect(alert().text()).toContain('Retry')
    await openTab('overview')
    expect(alert().exists()).toBe(false)
    await primary().trigger('click')
    await flushPromises()
    expect(api.inbox.act).toHaveBeenCalledWith((item as { taskId: string }).taskId, expect.objectContaining({ action: 'approve' }))
  } finally {
    wrapper.unmount()
  }
})

it('reloads the PR through Retry, back through its loading state', async () => {
  const { wrapper, openTab, alert } = await mountInbox('human_review', 'COR-5', null, true, task => task, false, false, () => {
    vi.mocked(api.projects.pullRequest).mockRejectedValue(new Error('Runner offline'))
  })
  try {
    await openTab('pr')
    let finish = (_: (typeof pullRequestDetails)[number]) => {}
    vi.mocked(api.projects.pullRequest).mockReturnValue(new Promise((resolve) => {
      finish = resolve
    }))
    await alert().find('button').trigger('click')
    expect(wrapper.find('[data-testid="inbox-pr-loading"]').exists()).toBe(true)
    finish(pullRequestDetails[0]!)
    await flushPromises()
    expect(alert().exists()).toBe(false)
    expect(wrapper.find('[data-testid="inbox-pr-description"]').exists()).toBe(true)
    expect(wrapper.get('[data-tab="diff"]').text()).toBe(`Code diff ${pullRequestDetails[0]!.totalFiles}`)
  } finally {
    wrapper.unmount()
  }
})

it('refetches the open PR when a run on its task ends, not while one is going', async () => {
  const { wrapper, openTab, emitLive } = await mountInbox('human_review', 'COR-5')
  try {
    await openTab('diff')
    const run = { id: 'r-1', agentId: 'a-1', projectId: 'p-corral', taskRef: 'COR-5', endedAt: null }
    vi.mocked(api.projects.pullRequest).mockClear()
    await emitLive({ type: 'run.updated', run })
    await flushPromises()
    expect(api.projects.pullRequest).not.toHaveBeenCalled()
    await emitLive({ type: 'run.updated', run: { ...run, taskRef: 'COR-6', endedAt: inbox().activity[0]!.at } })
    await flushPromises()
    expect(api.projects.pullRequest).not.toHaveBeenCalled()
    const pushed = { ...pullRequestDetails[0]!, totalFiles: 9 }
    vi.mocked(api.projects.pullRequest).mockResolvedValue(pushed)
    await emitLive({ type: 'run.updated', run: { ...run, endedAt: inbox().activity[0]!.at } })
    await flushPromises()
    expect(api.projects.pullRequest).toHaveBeenCalledTimes(1)
    expect(wrapper.get('[data-tab="diff"]').text()).toBe('Code diff 9')
  } finally {
    wrapper.unmount()
  }
})

it('sends nothing for unticked human checks, opens Criteria and says why, then approves once ticked', async () => {
  const check = { id: 'check', position: 0, text: 'Looks right', met: null, checkedByHuman: true }
  const { wrapper, primary, alert, composer } = await mountInbox('human_review', 'COR-5', null, true, task => ({ ...task, acceptanceCriteria: [check] }))
  try {
    expect(wrapper.findComponent(evidenceStub).exists()).toBe(false)
    await primary().trigger('click')
    await flushPromises()
    expect(api.inbox.act).not.toHaveBeenCalled()
    expect(alert().text()).toBe('Tick each human check before approving.')
    expect(composer().props('placeholder')).toMatch(/^Reply to/)
    wrapper.getComponent(evidenceStub).vm.$emit('update:checked', ['check'])
    await flushPromises()
    expect(alert().exists()).toBe(false)
    await primary().trigger('click')
    await flushPromises()
    expect(api.inbox.act).toHaveBeenCalledOnce()
  } finally {
    wrapper.unmount()
  }
})

it('sends approval on one click, and opens the composer for what needs words', async () => {
  const { wrapper, item, primary, composer } = await mountInbox('human_review', 'COR-5')
  try {
    expect(wrapper.find('[data-testid="inbox-overview-loading"]').exists()).toBe(false)
    expect(composer().props('placeholder')).toMatch(/^Reply to/)
    await wrapper.findAll('button').find(b => b.text() === 'Request changes')!.trigger('click')
    expect(api.inbox.act).not.toHaveBeenCalled()
    expect(composer().props('submitLabel')).toBe('Request changes')
    await wrapper.findAll('button').find(b => b.text() === 'Cancel')!.trigger('click')
    expect(composer().props('placeholder')).toMatch(/^Reply to/)
    await primary().trigger('click')
    await flushPromises()
    expect(api.inbox.act).toHaveBeenCalledWith((item as { taskId: string }).taskId, { action: 'approve', text: '' })
  } finally {
    wrapper.unmount()
  }
})

it('asks for a reason before deleting, and replies with no action chosen even if the task failed to load', async () => {
  const { wrapper, item, composer } = await mountInbox('failed')
  try {
    await wrapper.findAll('button').find(b => b.text() === 'Delete task')!.trigger('click')
    expect(api.inbox.act).not.toHaveBeenCalled()
    expect(composer().props('submitLabel')).toBe('Delete task')
    await wrapper.findAll('button').find(b => b.text() === 'Cancel')!.trigger('click')
    vi.mocked(api.tasks.comment).mockResolvedValue({ id: 'c1' } as never)
    await (composer().props('onSubmit') as (message: string) => Promise<boolean>)('Any news?')
    const failed = item as { project: { slug: string }, taskRef: string }
    expect(api.tasks.comment).toHaveBeenCalledWith(failed.project.slug, Number(failed.taskRef.split('-')[1]), 'Any news?')
  } finally {
    wrapper.unmount()
  }
})

it('hides criteria and review history until their tab opens, and shows no actions on Activity', async () => {
  const latestReview = { id: 'r1', round: 0, verdict: 'approved', headSha: 'abc1234', summary: 'Fine', criteria: [], createdAt: inbox().activity[0]!.at } as never
  const { wrapper, params, openTab } = await mountInbox('human_review', 'COR-5', null, true, task => ({ ...task, latestReview }))
  try {
    expect(wrapper.findComponent(evidenceStub).exists()).toBe(false)
    expect(wrapper.find('[data-tab="review"]').exists()).toBe(true)
    await openTab('criteria')
    expect(wrapper.findComponent(evidenceStub).exists()).toBe(true)
    params.itemId = inbox().activity[0]!.id
    await flushPromises()
    expect(wrapper.find('[data-testid="inbox-actions"]').exists()).toBe(false)
    expect(wrapper.find('[data-testid="inbox-read-only"]').text()).toBe('For your information. Nothing to do.')
    expect(wrapper.findComponent(composerStub).exists()).toBe(false)
  } finally {
    wrapper.unmount()
  }
})

for (const type of ['human_review', 'failed'] as const) {
  it(`waits for an attached image before the one-click ${type === 'human_review' ? 'approval' : 'retry'}`, async () => {
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:preview', revokeObjectURL: vi.fn() })
    const ref = type === 'human_review' ? 'COR-5' : inbox().needsYou.find(i => i.type === 'failed')!.taskRef!
    const { wrapper, item, primary } = await mountInbox(type, ref, null, true, task => task, true)
    try {
      let finish!: (value: never) => void
      vi.mocked(api.attachments.upload).mockReturnValue(new Promise((resolve) => {
        finish = resolve
      }))
      const input = wrapper.get('input[type="file"]')
      Object.defineProperty(input.element, 'files', { value: [new File(['image'], 'screen.png', { type: 'image/png' })] })
      await input.trigger('change')
      await primary().trigger('click')
      await flushPromises()
      expect(api.inbox.act).not.toHaveBeenCalled()
      // A second click while uploading must not queue another action.
      await primary().trigger('click')
      finish({ id: 'uploaded-image' } as never)
      await flushPromises()
      expect(api.inbox.act).toHaveBeenCalledExactlyOnceWith((item as { taskId: string }).taskId, expect.objectContaining({
        action: type === 'human_review' ? 'approve' : 'resolve',
        text: '![screen.png](attachment:uploaded-image)'
      }))
    } finally {
      wrapper.unmount()
    }
  })
}

describe('on a phone', () => {
  let mounted: { unmount: () => void } | undefined
  afterEach(() => mounted?.unmount())
  const phone = async (type: 'human_review' | 'failed' | 'question' = 'human_review', ref = 'COR-5', edit = (t: (typeof tasks)[number]) => t, editApi = () => {}) => {
    const view = await mountInbox(type, ref, null, true, edit, false, true, editApi)
    mounted = view.wrapper
    return view
  }
  const bar = (view: Awaited<ReturnType<typeof phone>>) => view.wrapper.get('[data-testid="inbox-thumb-bar"]')
  const button = (view: Awaited<ReturnType<typeof phone>>, label: string) => bar(view).findAll('button').find(b => b.text().includes(label))!
  const composerOpen = (view: Awaited<ReturnType<typeof phone>>) => (view.composer().element.closest('[style]') as HTMLElement | null)?.style.display !== 'none'

  it('puts the actions in the bar, not the top block, and sends Approve on the tap', async () => {
    const view = await phone()
    expect(view.wrapper.find('[data-testid="inbox-actions"]').exists()).toBe(false)
    expect(bar(view).findAll('button').map(b => b.text())).toEqual(['Approve and merge', 'Request changes', 'Reply'])
    expect(composerOpen(view)).toBe(false)
    await view.primary().trigger('click')
    await flushPromises()
    expect(api.inbox.act).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'approve' }))
  })

  it('opens the composer above the bar for Request changes and Reply', async () => {
    const view = await phone()
    await button(view, 'Request changes').trigger('click')
    await flushPromises()
    expect(composerOpen(view)).toBe(true)
    expect(view.panel().action).toBe('request_changes')
    await button(view, 'Reply').trigger('click')
    await flushPromises()
    expect(composerOpen(view)).toBe(true)
    expect(view.panel().action).toBeNull()
    expect(api.inbox.act).not.toHaveBeenCalled()
  })

  it('opens a question with Answer selected and its composer visible', async () => {
    const view = await phone('question', 'COR-8')
    expect(view.panel().action).toBe('clarify')
    expect(composerOpen(view)).toBe(true)
    expect(bar(view).text()).toContain('Answer')
    expect(api.inbox.act).not.toHaveBeenCalled()
  })

  it.each(['Cancel', 'Reply'])('keeps a draft visible after %s before approval', async (control) => {
    const view = await phone()
    await button(view, control === 'Cancel' ? 'Request changes' : 'Reply').trigger('click')
    view.panel().setText('Do not merge, the migration is wrong')
    await flushPromises()
    await button(view, control).trigger('click')
    await flushPromises()
    expect(composerOpen(view)).toBe(true)
    expect(view.composer().props('modelValue')).toBe('Do not merge, the migration is wrong')
    expect(api.inbox.act).not.toHaveBeenCalled()
    view.panel().setText('')
    await flushPromises()
    expect(composerOpen(view)).toBe(false)
  })

  it('keeps an image-only draft visible after Cancel and toggling Reply off', async () => {
    vi.stubGlobal('URL', { createObjectURL: () => 'blob:preview', revokeObjectURL: vi.fn() })
    const view = await mountInbox('human_review', 'COR-5', null, true, task => task, true, true)
    mounted = view.wrapper
    vi.mocked(api.attachments.upload).mockResolvedValue({ id: 'image' } as never)
    await button(view, 'Request changes').trigger('click')
    const input = view.wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [new File(['image'], 'screen.png', { type: 'image/png' })] })
    await input.trigger('change')
    await flushPromises()
    await button(view, 'Cancel').trigger('click')
    await flushPromises()
    const images = () => view.wrapper.get('[aria-label="Attached images"]')
    expect(images().isVisible()).toBe(true)
    await button(view, 'Reply').trigger('click')
    await button(view, 'Reply').trigger('click')
    await flushPromises()
    expect(images().isVisible()).toBe(true)
    expect(api.inbox.act).not.toHaveBeenCalled()
  })

  it('closes the Reply composer once the reply is sent', async () => {
    const view = await phone()
    vi.mocked(api.tasks.comment).mockResolvedValue({} as never)
    await button(view, 'Reply').trigger('click')
    await flushPromises()
    await (view.composer().vm as unknown as { onSubmit: (text: string) => Promise<boolean> }).onSubmit('On it')
    await flushPromises()
    expect(api.tasks.comment).toHaveBeenCalled()
    expect(composerOpen(view)).toBe(false)
  })

  it('stops approval on an unticked human check, as on desktop', async () => {
    const check = { id: 'check', position: 0, text: 'Looks right', met: null, checkedByHuman: true }
    const view = await phone('human_review', 'COR-5', t => ({ ...t, acceptanceCriteria: [check] }))
    await view.primary().trigger('click')
    await flushPromises()
    expect(api.inbox.act).not.toHaveBeenCalled()
    expect(view.panel().tab).toBe('criteria')
    expect(view.alert().text()).toContain('Tick each human check')
    view.panel().setCheckedHumanCriteria(['check'])
    await flushPromises()
    await view.primary().trigger('click')
    await flushPromises()
    expect(api.inbox.act).toHaveBeenCalledOnce()
  })

  it('keeps Retry\'s status in the bar', async () => {
    const view = await phone('failed', 'COR-9')
    expect(bar(view).findAll('button').map(b => b.text())).toEqual(['Retry', 'Send back', 'Delete', 'Reply'])
    await view.primary().trigger('click')
    await flushPromises()
    expect(api.inbox.act).toHaveBeenCalledWith(expect.anything(), expect.objectContaining({ action: 'resolve', to: 'in_progress' }))
  })

  it('shows the PR error and Retry in its tabs', async () => {
    const view = await phone('human_review', 'COR-5', t => t, () => {
      vi.mocked(api.projects.pullRequest).mockRejectedValue(new Error('Runner offline'))
    })
    await view.openTab('diff')
    expect(view.alert().text()).toContain('Couldn\'t load this pull request')
    expect(view.alert().text()).toContain('Retry')
    expect(view.wrapper.find('[data-testid="inbox-thumb-bar"]').exists()).toBe(true)
  })

  it('shows no action bar on a read-only item', async () => {
    const view = await phone()
    for (const read of [inbox().activity[0]!, inbox().resolved[0]!]) {
      view.params.itemId = read.id
      await flushPromises()
      expect(view.wrapper.find('[data-testid="inbox-panel-option-d"]').exists()).toBe(true)
      expect(view.wrapper.find('[data-testid="inbox-thumb-bar"]').exists()).toBe(false)
    }
  })
})
