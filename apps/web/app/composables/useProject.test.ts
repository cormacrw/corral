// @vitest-environment happy-dom
import { flushPromises, mount } from '@vue/test-utils'
import { VueQueryPlugin } from '@tanstack/vue-query'
import { computed, ref, watch } from 'vue'
import { expect, it, vi } from 'vitest'
import type { Project, Run, Task } from '@corral/contracts'
import { testQueryClient } from '~/queries/mount-with-query'
import { applyEvent, invalidateKeys } from '~/queries/dependencies'
import { keys } from '~/queries/keys'
import { PULL_REQUESTS_POLL_MS } from '~/queries/projects'

const api = vi.hoisted(() => ({ projects: { list: vi.fn(), pullRequests: vi.fn(async () => []), flow: vi.fn(async () => ({})) } }))
vi.mock('~/composables/useApi', () => ({ api }))
for (const [name, value] of Object.entries({
  watch,
  useProjectLists: () => ({ tasks: computed(() => []), epics: computed(() => []), loading: computed(() => false), error: computed(() => null) }),
  useProjectOverview: vi.fn()
})) vi.stubGlobal(name, value)
const { provideProject } = await import('./useProject')

it('prefetches once on Board without polling or refetching on task/run events', async () => {
  vi.useFakeTimers()
  const client = testQueryClient()
  const project = { id: 'p1', slug: 'corral' } as Project
  client.setQueryData(keys.projects.list(), [project])
  const slug = ref('corral')
  const wrapper = mount({
    setup() {
      provideProject(computed(() => slug.value), () => false)
      return () => null
    }
  }, { global: { plugins: [[VueQueryPlugin, { queryClient: client }]] } })
  try {
    await flushPromises()
    expect(api.projects.pullRequests).toHaveBeenCalledExactlyOnceWith('corral')
    const query = client.getQueryCache().find({ queryKey: keys.projects.pullRequests('corral') })!
    expect(query.getObserversCount()).toBe(0)
    await vi.advanceTimersByTimeAsync(2 * PULL_REQUESTS_POLL_MS)
    expect(api.projects.pullRequests).toHaveBeenCalledTimes(1)

    const task = { id: 't1', projectId: project.id, ref: 'COR-1', epicId: null, status: 'ready' } as Task
    await invalidateKeys(client, applyEvent(client, { type: 'task.updated', task }))
    const run = { id: 'r1', projectId: project.id, agentId: 'a1', taskRef: 'COR-1' } as Run
    await invalidateKeys(client, applyEvent(client, { type: 'run.updated', run }))
    await vi.advanceTimersByTimeAsync(2 * PULL_REQUESTS_POLL_MS)
    expect(query.state.isInvalidated).toBe(true)
    expect(api.projects.pullRequests).toHaveBeenCalledTimes(1)
  } finally {
    wrapper.unmount()
    client.clear()
    vi.useRealTimers()
  }
})
