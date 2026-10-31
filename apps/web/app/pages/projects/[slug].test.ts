// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { computed, ref } from 'vue'
import { expect, it, vi } from 'vitest'
import Project from './[slug].vue'
import { keys } from '~/queries/keys'
import { testQueryClient } from '~/queries/mount-with-query'

const { list } = vi.hoisted(() => ({ list: vi.fn() }))
vi.mock('~/composables/useApi', () => ({ api: { projects: { list } } }))
vi.stubGlobal('computed', computed)
vi.stubGlobal('useRoute', () => ({ params: { slug: 'corral' } }))
const removing = ref<string | null>(null)
vi.stubGlobal('useRemovingProject', () => removing)

function render(client = testQueryClient()) {
  return { client, wrapper: mount(Project, { global: { plugins: [[VueQueryPlugin, { queryClient: client }]], components: { ProjectNotFound: { template: '<p>not found</p>' }, NuxtPage: { template: '<p>page</p>' } } } }) }
}

it('shows the page while the list loads and for a project in it', async () => {
  list.mockResolvedValue([{ slug: 'corral' }])
  const { wrapper } = render()
  expect(wrapper.text()).toBe('page')
  await flushPromises()
  expect(wrapper.text()).toBe('page')
})
it('shows not found once the list lacks the project, as after a removal', async () => {
  list.mockResolvedValue([{ slug: 'corral' }])
  const client = testQueryClient()
  client.setQueryData(keys.projects.list(), [{ slug: 'corral' }])
  const { wrapper } = render(client)
  await flushPromises()
  client.setQueryData(keys.projects.list(), [{ slug: 'other' }])
  await flushPromises()
  expect(wrapper.text()).toBe('not found')
})
it('stays on the page while it removes that project itself', async () => {
  const client = testQueryClient()
  client.setQueryData(keys.projects.list(), [{ slug: 'corral' }])
  list.mockResolvedValue([{ slug: 'corral' }])
  const { wrapper } = render(client)
  await flushPromises()
  removing.value = 'corral'
  client.setQueryData(keys.projects.list(), [])
  await flushPromises()
  expect(wrapper.text()).toBe('page')
  removing.value = null
  await flushPromises()
  expect(wrapper.text()).toBe('not found')
})
