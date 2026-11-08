// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { enableAutoUnmount, flushPromises, mount, shallowMount } from '@vue/test-utils'
import { afterEach, expect, it, vi } from 'vitest'
import * as vue from 'vue'
import { createMemoryHistory, createRouter } from 'vue-router'
import { api } from '~/queries/api'
import type { Task } from '@corral/contracts'
import { useTaskFlyout } from '~/composables/useTaskFlyout'
import { testQueryClient } from '~/queries/mount-with-query'
import TaskDependencies from '~/features/tasks/components/TaskDependencies.vue'
import TaskDetail from '~/features/tasks/components/TaskDetail.vue'
import TaskProperties from '~/features/tasks/components/TaskProperties.vue'
import TaskLink from '~/components/shared/TaskLink.vue'

vi.mock('~/queries/api', () => {
  const none = () => vi.fn().mockResolvedValue([])
  return { api: { tasks: { byRef: vi.fn(), comments: none(), history: none(), evidence: none(), reviews: none(), designs: none() }, runs: { list: none() } }, ApiError: class extends Error {} }
})
enableAutoUnmount(afterEach)
// A plain task with every field the detail reads
const baseTask = {
  id: 't-1', projectId: 'p-corral', ref: 'TA-1', number: 1, title: 'Task', description: null, implementationPlan: null,
  priority: 'medium', type: 'task', kind: 'normal', epicId: null, parentTask: null, rollup: null, humanReview: false,
  reviewRounds: 0, failedRuns: 0, paused: false, branch: null, pr: null, acceptanceCriteria: [], dependsOn: [], waitingOnEpics: [],
  lease: null, developer: null, reviewer: null, headSha: null, latestReview: null, mergeCommitSha: null, mergedAt: null,
  submission: null, gateChecks: null, design: null, status: 'backlog', statusReason: null, draftSession: null,
  createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z'
} as Task
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
  vi.mocked(api.tasks.byRef).mockResolvedValue({ ...baseTask, dependsOn: ['TA-2'] })
  const wrapper = mount(TaskDetail, {
    props: { taskRef: 'TA-1', mode: 'page' },
    global: { plugins: [router, [VueQueryPlugin, { queryClient: testQueryClient() }]], components: { TaskLink, TaskDependencies }, stubs: { CriterionMetIcon: true } }
  })
  await flushPromises()
  const dependency = wrapper.get('a[href="/tasks/TA-2"]')
  await dependency.trigger('click', { button: 0 })
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/tasks/TA-2')
})

it.each([false, true])('links the design version with a real href in stacked=%s properties', async (stacked) => {
  const router = await setup()
  const wrapper = shallowMount(TaskProperties, {
    props: { task: { ...baseTask, design: { taskRef: 'TA-3', version: 2, screens: [], newerVersion: null } }, project: null, stacked },
    global: { plugins: [router, [VueQueryPlugin, { queryClient: testQueryClient() }]], components: { TaskLink }, stubs: { TaskLink: false, RouterLink: false } }
  })
  const design = wrapper.get('a[href="/tasks/TA-3"]')
  expect(design.text()).toContain('TA-3')
  await design.trigger('click', { button: 0 })
  await flushPromises()
  expect(router.currentRoute.value.fullPath).toBe('/tasks/TA-3')
})
