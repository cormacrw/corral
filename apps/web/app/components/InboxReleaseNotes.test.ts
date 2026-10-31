// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '~/composables/useApi'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'
import { releaseNotes } from '~/prototype/fixtures'
import InboxReleaseNotes from './InboxReleaseNotes.vue'
import MarkdownText from './MarkdownText.vue'

vi.mock('~/queries/shell', () => ({ shell: () => ({ projects: { data: { value: [{ prefix: 'COR' }] } } }) }))
vi.mock('~/composables/useTaskFlyout', () => ({ FLYOUT_SHEETS: Symbol(), useTaskFlyout: () => ({ open: vi.fn() }) }))
vi.mock('~/composables/useApi', () => ({ api: { deployments: { read: vi.fn().mockResolvedValue({}), dismiss: vi.fn().mockResolvedValue({}) } } }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('shows the error when reading fails, without retrying in a loop', async () => {
  for (const name of ['ref', 'watch', 'computed'] as const) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  vi.mocked(api.deployments.read).mockRejectedValueOnce(new Error('Server unavailable'))
  const client = testQueryClient()
  const wrapper = mount(InboxReleaseNotes, {
    props: { item: releaseNotes[0]! },
    global: { plugins: [[VueQueryPlugin, { queryClient: client }]], components: { MarkdownText, UAlert: vue.defineComponent({ props: ['title'], setup: props => () => vue.h('p', props.title) }) }, stubs: { UButton: true, AgentAvatar: true, ProjectThumbnail: true } }
  })
  await flushPromises()
  expect(wrapper.text()).toContain('Server unavailable')
  await wrapper.setProps({ item: { ...releaseNotes[0]! } })
  expect(api.deployments.read).toHaveBeenCalledOnce()
  wrapper.unmount()
})

it('marks an opened item read, replaces pending notes live, links task refs and dismisses', async () => {
  for (const name of ['ref', 'watch', 'computed'] as const) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/tasks/:ref', component: { template: '<div>Task</div>' } }] })
  const button = vue.defineComponent({ props: ['label'], emits: ['click'], setup: (props, { emit }) => () => vue.h('button', { onClick: () => emit('click') }, props.label) })
  const note = releaseNotes[0]!
  const client = testQueryClient()
  client.setQueryData(keys.inbox(), { count: 0, needsYou: [note], activity: [], resolved: [] })
  const wrapper = mount(InboxReleaseNotes, {
    props: { item: { ...releaseNotes[0]!, notesStatus: 'pending', notes: null } },
    global: { plugins: [router, [VueQueryPlugin, { queryClient: client }]], components: { MarkdownText, UButton: button }, stubs: { UAlert: true, AgentAvatar: true, ProjectThumbnail: true, UModal: true } }
  })
  await flushPromises()
  expect(api.deployments.read).toHaveBeenCalledWith('release-demo')
  expect(client.getQueryData<{ needsYou: { unread: boolean }[] }>(keys.inbox())?.needsYou[0]?.unread).toBe(false)
  expect(wrapper.text()).toContain('Writing release notes…')
  await wrapper.setProps({ item: { ...releaseNotes[0]!, unread: false } })
  expect(wrapper.text()).not.toContain('Writing release notes…')
  expect(wrapper.find('h3').text()).toBe('What shipped')
  await wrapper.get('a').trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.path).toBe('/tasks/COR-3')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(api.deployments.dismiss).toHaveBeenCalledWith('release-demo')
  wrapper.unmount()
})
