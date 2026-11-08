// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import type { ReleaseNotesItem } from '@corral/contracts'
import { enableAutoUnmount, flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '~/queries/api'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'
import { project } from '~/features/inbox/test-items'
import InboxReleaseNotes from '~/features/inbox/components/InboxReleaseNotes.vue'
import MarkdownText from '~/components/shared/MarkdownText.vue'

vi.mock('~/queries/shell', () => ({ useShell: () => ({ projects: [{ prefix: 'COR' }], agents: [] }) }))
vi.mock('~/composables/useTaskFlyout', () => ({ useFlyoutHost: () => ({ docked: () => false, sheets: false }), useTaskFlyout: () => ({ open: vi.fn() }) }))
vi.mock('~/queries/api', () => ({ api: { deployments: { read: vi.fn().mockResolvedValue({}), dismiss: vi.fn().mockResolvedValue({}) } } }))
enableAutoUnmount(afterEach)
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

const note: ReleaseNotesItem = {
  id: 'release-1', deploymentId: 'release-1', type: 'release_notes', project,
  subject: 'Release notes', preview: '', sender: { name: 'Juno', role: 'pm' }, at: '2026-11-01T00:00:00.000Z',
  fromSha: 'a1', toSha: 'b2', notes: '## What shipped\n\n- COR-3 makes tasks easier to find.',
  notesStatus: 'ready', unread: true, taskId: null, taskRef: null, prUrl: null, resolution: null
}
// The memory history starts at '/', which needs a route
const routes = [{ path: '/', component: { template: '<div />' } }, { path: '/tasks/:ref', component: { template: '<div>Task</div>' } }]

it('shows the error when reading fails, without retrying in a loop', async () => {
  for (const name of ['ref', 'watch', 'computed'] as const) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  vi.mocked(api.deployments.read).mockRejectedValueOnce(new Error('Server unavailable'))
  const client = testQueryClient()
  const router = createRouter({ history: createMemoryHistory(), routes })
  const wrapper = mount(InboxReleaseNotes, {
    props: { item: note },
    global: { plugins: [router, [VueQueryPlugin, { queryClient: client }]], components: { MarkdownText, AppAlert: vue.defineComponent({ props: ['title'], setup: props => () => vue.h('p', props.title) }) }, stubs: { AppButton: true, AgentAvatar: true, ProjectThumbnail: true } }
  })
  await flushPromises()
  expect(wrapper.text()).toContain('Server unavailable')
  await wrapper.setProps({ item: { ...note } })
  expect(api.deployments.read).toHaveBeenCalledOnce()
})

it('marks an opened item read, replaces pending notes live, links task refs and dismisses', async () => {
  for (const name of ['ref', 'watch', 'computed'] as const) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  const router = createRouter({ history: createMemoryHistory(), routes })
  const button = vue.defineComponent({ props: ['label'], emits: ['click'], setup: (props, { emit }) => () => vue.h('button', { onClick: () => emit('click') }, props.label) })
  const client = testQueryClient()
  client.setQueryData(keys.inbox(), { count: 0, needsYou: [], activity: [note], resolved: [] })
  const wrapper = mount(InboxReleaseNotes, {
    props: { item: { ...note, notesStatus: 'pending', notes: null } },
    global: { plugins: [router, [VueQueryPlugin, { queryClient: client }]], components: { MarkdownText, AppButton: button }, stubs: { AppAlert: true, AgentAvatar: true, ProjectThumbnail: true, AppModal: true } }
  })
  await flushPromises()
  expect(api.deployments.read).toHaveBeenCalledWith('release-1')
  expect(client.getQueryData<{ activity: { unread: boolean }[] }>(keys.inbox())?.activity[0]?.unread).toBe(false)
  expect(wrapper.text()).not.toContain('What shipped')
  await wrapper.setProps({ item: { ...note, unread: false } })
  expect(wrapper.text()).toContain('What shipped')
  await wrapper.get('a').trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.path).toBe('/tasks/COR-3')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(api.deployments.dismiss).toHaveBeenCalledWith('release-1')
})
