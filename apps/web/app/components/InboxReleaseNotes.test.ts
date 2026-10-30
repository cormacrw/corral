// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '~/composables/useApi'
import { releaseNotes } from '~/prototype/fixtures'
import InboxReleaseNotes from './InboxReleaseNotes.vue'
import MarkdownText from './MarkdownText.vue'

vi.mock('~/composables/useApi', () => ({ api: { deployments: { read: vi.fn().mockResolvedValue({}), dismiss: vi.fn().mockResolvedValue({}) } } }))
afterEach(() => {
  vi.unstubAllGlobals()
  vi.clearAllMocks()
})

it('marks an opened item read, replaces pending notes live, links task refs and dismisses', async () => {
  for (const name of ['ref', 'watch'] as const) vi.stubGlobal(name, vue[name])
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/tasks/:ref', component: { template: '<div>Task</div>' } }] })
  const button = vue.defineComponent({ props: ['label'], emits: ['click'], setup: (props, { emit }) => () => vue.h('button', { onClick: () => emit('click') }, props.label) })
  const wrapper = mount(InboxReleaseNotes, {
    props: { item: { ...releaseNotes[0]!, notesStatus: 'pending', notes: null } },
    global: { plugins: [router], components: { MarkdownText, UButton: button }, stubs: { UAlert: true, AgentAvatar: true, ProjectThumbnail: true, UModal: true } }
  })
  await flushPromises()
  expect(api.deployments.read).toHaveBeenCalledWith('release-demo')
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
  expect(wrapper.emitted('refresh')).toHaveLength(2)
  wrapper.unmount()
})
