// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { enableAutoUnmount, flushPromises, mount, shallowMount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '~/composables/useApi'
import { tasks } from '~/prototype/fixtures'
import { useTaskFlyout } from '~/features/tasks/composables/useTaskFlyout'
import { testQueryClient } from '~/queries/mount-with-query'
import TaskDependencies from '~/features/tasks/components/TaskDependencies.vue'
import TaskDetail from '~/features/tasks/components/TaskDetail.vue'
import TaskProperties from '~/features/tasks/components/TaskProperties.vue'
import TaskLink from '~/features/tasks/components/TaskLink.vue'

vi.mock('~/composables/useApi', () => {
  const none = () => vi.fn().mockResolvedValue([])
  return { api: { tasks: { byRef: vi.fn(), comments: none(), history: none(), evidence: none(), reviews: none(), designs: none() }, runs: { list: none() } }, ApiError: class extends Error {} }
})
enableAutoUnmount(afterEach)
afterEach(() => {
  vi.unstubAllGlobals()
  sessionStorage.clear()
})

async function setup() {
  for (const name of ['ref', 'computed', 'watch', 'onMounted', 'onBeforeUnmount', 'useTemplateRef'] as const) vi.stubGlobal(name, vue[name])
  const router = createRouter({ history: createMemoryHistory(), routes: [{ path: '/:all(.*)*', component: { template: '<div />' } }] })
  await router.push('/tasks/TA-1')
  vi.stubGlobal('useRoute', () => router.currentRoute.value)
  vi.stubGlobal('useRouter', () => router)
  vi.stubGlobal('useDevice', () => ({ isMobile: vue.ref(false) }))
  vi.stubGlobal('useTaskFlyout', useTaskFlyout)
  vi.stubGlobal('useToast', () => ({ add: vi.fn() }))
  vi.stubGlobal('useShell', () => ({ projects: [], agents: [] }))
  vi.stubGlobal('useProjectLists', () => ({ tasks: vue.ref([]), epics: vue.ref([]) }))
  return router
}

it('gives a dependency a real href and navigates from a task page without a flyout host', async () => {
  const router = await setup()
  vi.mocked(api.tasks.byRef).mockResolvedValue({ ...tasks[0]!, dependsOn: ['TA-2'] })
  const wrapper = mount(TaskDetail, {
    props: { taskRef: 'TA-1', mode: 'page' },
    global: { plugins: [router, [VueQueryPlugin, { queryClient: testQueryClient() }]], components: { TaskLink, TaskDependencies }, stubs: { CriterionMetIcon: true } }
  })
  await flushPromises()
  const dependency = wrapper.get('a[href="/tasks/TA-2"]')
  await dependency.trigger('click', { button: 0 })
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/tasks/TA-2')
  wrapper.unmount()
})

it.each([false, true])('links the design version with a real href in stacked=%s properties', async (stacked) => {
  const router = await setup()
  const wrapper = shallowMount(TaskProperties, {
    props: { task: { ...tasks[0]!, design: { taskRef: 'TA-3', version: 2, screens: [], newerVersion: null } }, project: null, stacked },
    global: { plugins: [router, [VueQueryPlugin, { queryClient: testQueryClient() }]], components: { TaskLink }, stubs: { TaskLink: false, RouterLink: false } }
  })
  const design = wrapper.get('a[href="/tasks/TA-3"]')
  expect(design.text()).toBe('TA-3 v2')
  await design.trigger('click', { button: 0 })
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/tasks/TA-3')
  wrapper.unmount()
})
