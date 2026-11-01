// @vitest-environment happy-dom
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises } from '@vue/test-utils'
import type { Project, Task } from '@corral/contracts'
import { applyEvent, invalidateKeys } from '~/queries/dependencies'
import { mountWithQuery, testQueryClient } from '~/queries/mount-with-query'

const api = vi.hoisted(() => ({
  inbox: { get: vi.fn() },
  runs: { list: vi.fn() },
  tasks: { history: vi.fn() }
}))
vi.mock('~/composables/useApi', () => ({ api }))
vi.mock('~/utils/projects', () => ({ projectNeedsYou: () => 0 }))
for (const [name, value] of Object.entries({ computed, ref, shallowRef, watch, onMounted, onBeforeUnmount })) vi.stubGlobal(name, value)
vi.stubGlobal('useShell', () => ({ agents: [] }))
const { useProjectOverview } = await import('./useProjectOverview')

const project = { id: 'p1', slug: 'corral' } as Project
const task = (id: string) => ({ id, ref: `COR-${id}`, number: 1, updatedAt: '2026-10-01' }) as Task

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function setup(initiallyOpen: boolean, initiallyLoading = false, client = testQueryClient()) {
  const open = ref(initiallyOpen)
  const tasks = ref([task('a')])
  const loading = ref(initiallyLoading)
  let overview!: ReturnType<typeof useProjectOverview>
  const { wrapper } = mountWithQuery({
    setup() {
      overview = useProjectOverview({ slug: computed(() => 'corral'), project: computed(() => project), tasks: computed(() => tasks.value), epics: computed(() => []), loading: computed(() => loading.value), error: computed(() => null), open: () => open.value })
      return () => null
    }
  }, { client })
  cleanups.push(() => wrapper.unmount())
  return { open, tasks, loading, overview, wrapper, client }
}
// What a run's change marks stale
const runChanged = (client: ReturnType<typeof testQueryClient>) =>
  invalidateKeys(client, applyEvent(client, { type: 'run.updated', run: { id: 'r1', projectId: 'p1', agentId: 'a1', taskRef: 'COR-a', state: 'running' } } as never))
const activeRunLoads = () => api.runs.list.mock.calls.filter(([filter]) => filter.active).length

beforeEach(() => {
  vi.clearAllMocks()
  api.inbox.get.mockResolvedValue({})
  api.runs.list.mockResolvedValue([])
  api.tasks.history.mockResolvedValue([])
})

it('loads once for the project and not again on coming back unchanged', async () => {
  const { open } = setup(false)
  await flushPromises()
  expect(activeRunLoads()).toBe(1)
  expect(api.inbox.get).toHaveBeenCalledTimes(1)
  open.value = true
  await nextTick()
  open.value = false
  await nextTick()
  open.value = true
  await flushPromises()
  expect(activeRunLoads()).toBe(1)
  expect(api.tasks.history).toHaveBeenCalledTimes(1)
})

it('holds changes while closed and catches up once on opening', async () => {
  const { open, tasks, client } = setup(false)
  await flushPromises()
  tasks.value = [task('b')]
  await runChanged(client)
  await flushPromises()
  expect(activeRunLoads()).toBe(1)
  expect(api.tasks.history).toHaveBeenCalledTimes(1)
  open.value = true
  await flushPromises()
  // run.updated writes the run into the list, so only the history is refetched
  expect(activeRunLoads()).toBe(1)
  expect(api.tasks.history).toHaveBeenLastCalledWith('corral', 1)
  expect(api.tasks.history).toHaveBeenCalledTimes(2)
})

it('holds changes on another tab when returning to a project over a warm cache', async () => {
  const first = setup(true)
  await flushPromises()
  first.wrapper.unmount()
  const { client } = setup(false, false, first.client)
  await flushPromises()
  expect(activeRunLoads()).toBe(1)
  await runChanged(client)
  await flushPromises()
  expect(activeRunLoads()).toBe(1)
})

it('stays live while open', async () => {
  const { tasks, client, overview } = setup(true)
  await flushPromises()
  tasks.value = [task('b')]
  await flushPromises()
  expect(api.tasks.history).toHaveBeenCalledTimes(2)
  await runChanged(client)
  await flushPromises()
  expect(overview.runs.value.map(run => run.id)).toEqual(['r1'])
  expect(activeRunLoads()).toBe(1)
})

it('waits for the project lists before loading activity', async () => {
  const { loading } = setup(true, true)
  await flushPromises()
  expect(activeRunLoads()).toBe(0)
  expect(api.tasks.history).not.toHaveBeenCalled()
  loading.value = false
  await flushPromises()
  expect(activeRunLoads()).toBe(1)
  expect(api.tasks.history).toHaveBeenCalledTimes(1)
})

it('keeps activity through a failed background refetch and retries only a cold failure', async () => {
  api.tasks.history.mockRejectedValueOnce(new Error('down'))
  const { overview, client } = setup(true)
  await flushPromises()
  expect(overview.error.value).toBe('down')
  const entry = { id: 'e', createdAt: '2026-10-31' }
  api.tasks.history.mockResolvedValue([entry])
  await overview.load()
  await flushPromises()
  expect(overview.error.value).toBeNull()
  expect(overview.history.value).toEqual([entry])
  api.tasks.history.mockRejectedValue(new Error('down'))
  await runChanged(client)
  await flushPromises()
  expect(overview.error.value).toBeNull()
  expect(overview.history.value).toEqual([entry])
})
