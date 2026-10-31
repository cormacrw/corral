// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { focusManager, useQuery, VueQueryPlugin } from '@tanstack/vue-query'
import { computed, defineComponent, h, reactive, ref } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { PullRequestStatus } from '@corral/contracts'
import { testQueryClient } from '~/queries/mount-with-query'
import { PULL_REQUESTS_POLL_MS, pullRequestsQuery } from '~/queries/projects'

const pullRequests = vi.hoisted(() => vi.fn())
vi.mock('~/composables/useApi', () => ({ api: { projects: { pullRequests } } }))
vi.mock('~/utils/pull-requests', () => {
  const cell = () => ({ label: '', color: 'neutral', detail: '' })
  return { ciCell: cell, evidenceCell: cell, mergeCell: cell, rebaseCell: cell, reviewCell: cell }
})

const route = reactive({ params: { slug: 'corral' } })
for (const [name, value] of Object.entries({
  computed, useSeoMeta: vi.fn(),
  // The parent route's observer, mounted with the page here
  useProject: () => ({ project: ref(null), pullRequests: useQuery(computed(() => pullRequestsQuery(route.params.slug))) }),
  useTaskFlyout: () => ({ ref: ref(null) }), useDevice: () => ({ isMobile: ref(true) })
})) vi.stubGlobal(name, value)
const { default: PullRequests } = await import('./pull-requests.vue')

const pr = (taskRef: string) => ({
  taskRef, taskTitle: taskRef, taskStatus: 'human_review', pr: { number: 1, url: '' },
  merge: { eligible: false, gates: [] }, humanReviewOutstanding: false
}) as unknown as PullRequestStatus

function hideTab(hidden: boolean): void {
  vi.spyOn(document, 'visibilityState', 'get').mockReturnValue(hidden ? 'hidden' : 'visible')
  document.dispatchEvent(new Event('visibilitychange', { bubbles: true }))
}

let client: ReturnType<typeof testQueryClient>
const mountPage = () => mount(PullRequests, {
  global: {
    plugins: [[VueQueryPlugin, { queryClient: client }]],
    components: { UDashboardPanel: defineComponent({ setup: (_, { slots }) => () => h('div', slots.default?.()) }) },
    stubs: { MobilePageHeader: true, USkeleton: true, UAlert: true, UButton: true, UBadge: true, UIcon: true, StatusBadge: true, TaskFlyout: true }
  }
})

beforeEach(() => {
  vi.useFakeTimers()
  client = testQueryClient()
  route.params.slug = 'corral'
  pullRequests.mockReset().mockImplementation(async (slug: string) => [pr(`${slug}-1`)])
})
afterEach(() => {
  client.clear()
  vi.useRealTimers()
  vi.restoreAllMocks()
  focusManager.setFocused(undefined)
})

it('reads GitHub every 30 seconds while the tab is visible and stops while hidden', async () => {
  const wrapper = mountPage()
  await vi.advanceTimersByTimeAsync(0)
  expect(pullRequests).toHaveBeenCalledTimes(1)
  await vi.advanceTimersByTimeAsync(PULL_REQUESTS_POLL_MS)
  expect(pullRequests).toHaveBeenCalledTimes(2)
  await vi.advanceTimersByTimeAsync(PULL_REQUESTS_POLL_MS)
  expect(pullRequests).toHaveBeenCalledTimes(3)
  hideTab(true)
  await vi.advanceTimersByTimeAsync(5 * PULL_REQUESTS_POLL_MS)
  expect(pullRequests).toHaveBeenCalledTimes(3)
  hideTab(false)
  await vi.advanceTimersByTimeAsync(0)
  expect(pullRequests).toHaveBeenCalledTimes(4)
  wrapper.unmount()
  const stopped = pullRequests.mock.calls.length
  await vi.advanceTimersByTimeAsync(5 * PULL_REQUESTS_POLL_MS)
  expect(pullRequests).toHaveBeenCalledTimes(stopped)
})

it('shows a project\'s cached list at once when switching back to it', async () => {
  const wrapper = mountPage()
  await flushPromises()
  await vi.advanceTimersByTimeAsync(0)
  expect(wrapper.text()).toContain('corral-1')
  route.params.slug = 'other'
  await vi.advanceTimersByTimeAsync(0)
  expect(wrapper.text()).toContain('other-1')
  pullRequests.mockImplementation(() => new Promise(() => {}))
  route.params.slug = 'corral'
  await wrapper.vm.$nextTick()
  expect(wrapper.text()).toContain('corral-1')
  expect(wrapper.text()).not.toContain('other-1')
  wrapper.unmount()
})
