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
  for (const name of ['ref', 'watch', 'computed'] as const) vi.stubGlobal(name, vue[name])
  vi.stubGlobal('useLive', () => ({ state: vue.ref({ projects: [{ prefix: 'COR' }] }) }))
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/tasks/:ref', component: { template: '<div>Task</div>' } }] })
  const button = vue.defineComponent({ props: ['label'], emits: ['click'], setup: (props, { emit }) => () => vue.h('button', { onClick: () => emit('click') }, props.label) })
  // Observe the parent's event listener directly: Vue Test Utils' emitted()
  // tracking relies on devtools hooks, which Vue disables in NODE_ENV=production.
  const onRefresh = vi.fn()
  const wrapper = mount(InboxReleaseNotes, {
    props: { onRefresh, item: { ...releaseNotes[0]!, notesStatus: 'pending', notes: null } },
    global: { plugins: [router], components: { MarkdownText, UButton: button }, stubs: { UAlert: true, AgentAvatar: true, ProjectThumbnail: true, UModal: true } }
  })
  await flushPromises()
  expect(api.deployments.read).toHaveBeenCalledWith('release-demo')
  expect(onRefresh).toHaveBeenCalledTimes(1)
  expect(wrapper.text()).toContain('Writing release notes…')
  await wrapper.setProps({ item: { ...releaseNotes[0]!, unread: false } })
  expect(wrapper.text()).not.toContain('Writing release notes…')
  expect(wrapper.find('h3').text()).toBe('What shipped')
  expect(onRefresh).toHaveBeenCalledTimes(1)
  await wrapper.get('a').trigger('click')
  await flushPromises()
  expect(router.currentRoute.value.path).toBe('/tasks/COR-3')
  await wrapper.get('button').trigger('click')
  await flushPromises()
  expect(api.deployments.dismiss).toHaveBeenCalledWith('release-demo')
  expect(onRefresh).toHaveBeenCalledTimes(2)
  wrapper.unmount()
})
