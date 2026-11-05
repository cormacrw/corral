// @vitest-environment happy-dom
// The Inbox page with its selected item, for what spans the page, the panel
// and the composer. The item's logic is tested through its composables
// (useInboxView, useInboxItem, useInboxPanel).
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount, type VueWrapper } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { api } from '~/composables/useApi'
import { agents, inbox, projects, pullRequestDetails, tasks } from '~/prototype/fixtures'
import { testQueryClient } from '~/queries/mount-with-query'
import AppLoadError from '~/components/app/AppLoadError.vue'
import PromptComposer from '~/components/shared/PromptComposer.vue'
import InboxEpicPanel from '~/features/inbox/components/InboxEpicPanel.vue'
import InboxMobileItem from '~/features/inbox/components/InboxMobileItem.vue'
import InboxPanel from '~/features/inbox/components/InboxPanel.vue'
import InboxPanelActions from '~/features/inbox/components/InboxPanelActions.vue'
import InboxPanelArtifacts from '~/features/inbox/components/InboxPanelArtifacts.vue'
import InboxPanelDetails from '~/features/inbox/components/InboxPanelDetails.vue'
import InboxPanelDiff from '~/features/inbox/components/InboxPanelDiff.vue'
import InboxPanelMeta from '~/features/inbox/components/InboxPanelMeta.vue'
import InboxPanelThumbBar from '~/features/inbox/components/InboxPanelThumbBar.vue'
import InboxPanelTray from '~/features/inbox/components/InboxPanelTray.vue'
import InboxPanelVerdict from '~/features/inbox/components/InboxPanelVerdict.vue'
import InboxReleaseNotes from '~/features/inbox/components/InboxReleaseNotes.vue'
import InboxPage from '~/pages/inbox.vue'
import InboxItemPage from '~/pages/inbox/[itemId].vue'
import InboxIndexPage from '~/pages/inbox/index.vue'

// PromptComposer imports this directly
vi.mock('~/composables/useDevice', () => ({ useDevice: () => (globalThis as unknown as { useDevice: () => unknown }).useDevice() }))
vi.mock('~/composables/useApi', () => ({
  api: {
    inbox: { get: vi.fn(), act: vi.fn(), read: vi.fn() },
    projects: { pullRequest: vi.fn() },
    tasks: { byRef: vi.fn(), evidence: vi.fn(), reviews: vi.fn(), designs: vi.fn() },
    attachments: { upload: vi.fn() }
  }
}))

const wrappers: VueWrapper[] = []
beforeEach(() => {
  vi.resetAllMocks()
  sessionStorage.clear()
})
afterEach(() => {
  wrappers.splice(0).forEach(w => w.unmount())
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

const plain = vue.defineComponent({ setup: (_, { slots }) => () => vue.h('div', slots.default?.()) })
const AppButton = vue.defineComponent({
  inheritAttrs: false,
  props: ['label', 'disabled', 'to', 'ariaLabel'],
  setup: (props, { attrs }) => () => vue.h(props.to ? 'a' : 'button', { ...attrs, disabled: props.disabled, href: props.to }, props.label ?? attrs['aria-label'] as string)
})
const AppTabs = vue.defineComponent({
  props: ['items'],
  setup: props => () => vue.h('div', (props.items as { label: string }[]).map(tab => vue.h('button', tab.label)))
})

async function mountInbox({ selected, mobile = false }: { selected: string, mobile?: boolean }) {
  for (const name of ['ref', 'shallowRef', 'computed', 'watch', 'watchEffect', 'onMounted', 'onBeforeUnmount', 'nextTick'] as const) vi.stubGlobal(name, vue[name])
  const params = vue.reactive<{ itemId?: string }>({ itemId: selected })
  vi.stubGlobal('useRoute', () => ({ params }))
  vi.stubGlobal('useRouter', () => ({ replace: vi.fn(), push: vi.fn(), resolve: (path: string) => ({ href: path }) }))
  vi.stubGlobal('definePageMeta', vi.fn())
  vi.stubGlobal('useSeoMeta', vi.fn())
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(mobile) }))
  vi.stubGlobal('useMobileHeader', () => vue.ref(null))
  vi.stubGlobal('useTaskPrefetch', () => () => undefined)
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  vi.stubGlobal('usePlanThreadDelete', () => ({ pending: vue.ref([]), remove: vi.fn() }))
  vi.stubGlobal('useTaskFlyout', () => ({ ref: vue.ref(null), epic: vue.ref(null), open: vi.fn(), close: vi.fn().mockResolvedValue(undefined) }))
  vi.stubGlobal('useShell', () => ({ agents, projects, loaded: true, runner: { online: true } }))
  vi.stubGlobal('URL', { createObjectURL: () => 'blob:preview', revokeObjectURL: vi.fn() })
  const data = inbox()
  vi.mocked(api.inbox.get).mockImplementation(async () => structuredClone(data))
  vi.mocked(api.inbox.read).mockResolvedValue({})
  vi.mocked(api.inbox.act).mockResolvedValue({ task: null })
  vi.mocked(api.tasks.byRef).mockImplementation(async ref => structuredClone(tasks.find(t => t.ref === ref)!))
  vi.mocked(api.tasks.evidence).mockResolvedValue([])
  vi.mocked(api.tasks.reviews).mockResolvedValue([])
  vi.mocked(api.tasks.designs).mockResolvedValue([])
  vi.mocked(api.projects.pullRequest).mockResolvedValue(structuredClone(pullRequestDetails[0]!))
  // As Nuxt renders the child: keyed by its path
  const NuxtPage = vue.defineComponent({ setup: () => () => params.itemId ? vue.h(InboxItemPage, { key: params.itemId }) : vue.h(InboxIndexPage) })
  // Attached, so isVisible sees the phone's v-show
  const wrapper = mount(InboxPage, { attachTo: document.body, global: {
    plugins: [[VueQueryPlugin, { queryClient: testQueryClient() }]],
    components: {
      NuxtPage, InboxEpicPanel, InboxPanel, InboxPanelThumbBar, InboxPanelActions, InboxPanelArtifacts, InboxPanelDetails, InboxPanelDiff, InboxPanelMeta, InboxPanelTray, InboxPanelVerdict, InboxReleaseNotes,
      ...(mobile && { InboxMobileItem, MobilePageHeader: plain }),
      PromptComposer, AppLoadError, AppButton, AppTabs, AppPanel: plain
    },
    stubs: {
      AppAlert: true, AppModal: true, EvidenceList: true, EvidenceViewer: true, InboxMessage: true, InboxDesignReviewLink: true, AppBadge: true, AppInput: true, Icon: true, UiSkeleton: true, AppSelectMenu: true,
      MarkdownText: true, TaskFlyout: true, AgentAvatar: true, ProjectThumbnail: true, PlanThreadRow: true, NuxtLink: true, InboxMobile: true,
      InboxEmpty: true, InboxRunnerUpdate: true, InboxPlanThread: true, InboxMobilePlanThread: true, InboxPanelEpicContext: true, InboxEpicDecision: true, TaskLink: true, TaskRefText: true, ...(!mobile && { InboxMobileItem: true })
    }
  } })
  wrappers.push(wrapper)
  await flushPromises()
  const button = (name: string) => wrapper.findAll('button').find(b => b.text() === name || b.attributes('aria-label') === name)!
  const attachImage = async () => {
    const input = wrapper.get('input[type="file"]')
    Object.defineProperty(input.element, 'files', { value: [new File(['image'], 'screen.png', { type: 'image/png' })] })
    await input.trigger('change')
  }
  return { wrapper, params, button, attachImage, primary: () => wrapper.get('[data-testid="inbox-primary"]'), composer: () => wrapper.find('textarea') }
}

const failed = () => inbox().needsYou.find(i => i.type === 'failed' && i.taskRef)!
const review = () => inbox().needsYou.find(i => i.taskRef === 'COR-5')!

it('has no draft left after going back to the list', async () => {
  const item = failed()
  const view = await mountInbox({ selected: item.id })
  await view.composer().setValue('my note')
  view.params.itemId = undefined
  await flushPromises()
  view.params.itemId = item.id
  await flushPromises()
  expect((view.composer().element as HTMLTextAreaElement).value).toBe('')
})

it('sends a one-click approval without a draft typed for a cancelled action', async () => {
  const item = review()
  const view = await mountInbox({ selected: item.id })
  await view.button('Request changes').trigger('click')
  await flushPromises()
  await view.composer().setValue('a hidden note')
  await view.button('Cancel').trigger('click')
  await flushPromises()
  expect(view.composer().exists()).toBe(false)
  await view.primary().trigger('click')
  await flushPromises()
  expect(api.inbox.act).toHaveBeenCalledExactlyOnceWith(item.taskId, { action: 'approve', text: '' })
})

// Approval has no composer open, so only Retry, which opens on its note, can
// carry an image
it('waits for an attached image before the one-click Retry, sending it once', async () => {
  const item = failed()
  const view = await mountInbox({ selected: item.id })
  let finish!: () => void
  vi.mocked(api.attachments.upload).mockReturnValue(new Promise((resolve) => {
    finish = () => resolve({ id: 'uploaded-image' } as never)
  }))
  await view.attachImage()
  await view.primary().trigger('click')
  await flushPromises()
  expect(api.inbox.act).not.toHaveBeenCalled()
  // A second click while uploading must not queue another action
  await view.primary().trigger('click')
  finish()
  await flushPromises()
  expect(api.inbox.act).toHaveBeenCalledExactlyOnceWith(item.taskId, expect.objectContaining({
    action: 'resolve',
    text: '![screen.png](attachment:uploaded-image)'
  }))
})

describe('on a phone, so a tap never sends a draft unseen', () => {
  it('keeps a typed draft visible after Cancel, until it is cleared', async () => {
    const view = await mountInbox({ selected: review().id, mobile: true })
    expect(view.composer().isVisible()).toBe(false)
    await view.button('Request changes').trigger('click')
    await flushPromises()
    await view.composer().setValue('Do not merge, the migration is wrong')
    await view.button('Cancel').trigger('click')
    await flushPromises()
    expect(view.composer().isVisible()).toBe(true)
    await view.composer().setValue('')
    await flushPromises()
    expect(view.composer().isVisible()).toBe(false)
    expect(api.inbox.act).not.toHaveBeenCalled()
  })

  it('keeps an image-only draft visible after Cancel', async () => {
    const view = await mountInbox({ selected: review().id, mobile: true })
    vi.mocked(api.attachments.upload).mockResolvedValue({ id: 'image' } as never)
    await view.button('Request changes').trigger('click')
    await view.attachImage()
    await flushPromises()
    await view.button('Cancel').trigger('click')
    await flushPromises()
    expect(view.wrapper.get('[aria-label="Attached images"]').isVisible()).toBe(true)
    expect(api.inbox.act).not.toHaveBeenCalled()
  })
})
