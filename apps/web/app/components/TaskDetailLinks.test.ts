// @vitest-environment happy-dom
import { flushPromises, shallowMount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '~/composables/useApi'
import { tasks } from '~/prototype/fixtures'
import { useTaskFlyout } from '~/composables/useTaskFlyout'
import TaskDetail from './TaskDetail.vue'
import TaskProperties from './TaskProperties.vue'
import TaskLink from './TaskLink.vue'

vi.mock('~/composables/useApi', () => ({ api: { tasks: { byRef: vi.fn() } }, ApiError: class extends Error {} }))
afterEach(() => vi.unstubAllGlobals())

async function setup() {
  for (const name of ['ref', 'computed', 'watch', 'onMounted', 'onBeforeUnmount', 'useTemplateRef'] as const) vi.stubGlobal(name, vue[name])
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:all(.*)*', component: { template: '<div />' } }] })
  await router.push('/tasks/TA-1')
  vi.stubGlobal('useRoute', () => router.currentRoute.value)
  vi.stubGlobal('useRouter', () => router)
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  vi.stubGlobal('useTaskFlyout', useTaskFlyout)
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  vi.stubGlobal('useLive', () => ({ state: vue.ref({ projects: [], agents: [], tasks: {}, epics: {} }), subscribe: () => () => {} }))
  return router
}

it('gives a dependency a real href and navigates from a task page without a flyout host', async () => {
  const router = await setup()
  vi.mocked(api.tasks.byRef).mockResolvedValue({ ...tasks[0]!, dependsOn: ['TA-2'] })
  const wrapper = shallowMount(TaskDetail, {
    props: { taskRef: 'TA-1', mode: 'page' },
    global: { plugins: [router], components: { TaskLink }, stubs: { TaskLink: false, RouterLink: false } }
  })
  await flushPromises()
  const dependency = wrapper.get('a[href="/tasks/TA-2"]')
  expect(dependency.classes()).toContain('font-mono')
  await dependency.trigger('click', { button: 0 })
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/tasks/TA-2')
  wrapper.unmount()
})

it.each([false, true])('links the design version with a real href in stacked=%s properties', async (stacked) => {
  const router = await setup()
  const wrapper = shallowMount(TaskProperties, {
    props: { task: { ...tasks[0]!, design: { taskRef: 'TA-3', version: 2, screens: [], newerVersion: null } }, project: null, statusOptions: [], statusEditable: false, priorityOptions: [], typeOptions: [], developer: null, reviewer: null, stacked },
    global: { plugins: [router], components: { TaskLink }, stubs: { TaskLink: false, RouterLink: false } }
  })
  const design = wrapper.get('a[href="/tasks/TA-3"]')
  expect(design.text()).toBe('TA-3 v2')
  await design.trigger('click', { button: 0 })
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/tasks/TA-3')
  wrapper.unmount()
})
