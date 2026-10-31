// @vitest-environment happy-dom
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { flushPromises, mount } from '@vue/test-utils'
import type { Project, Task } from '@corral/contracts'

const api = vi.hoisted(() => ({
  inbox: { get: vi.fn() },
  runs: { list: vi.fn() },
  tasks: { history: vi.fn() }
}))
vi.mock('~/composables/useApi', () => ({ api }))
vi.mock('~/utils/projects', () => ({ projectNeedsYou: () => 0 }))
for (const [name, value] of Object.entries({ computed, ref, watch, onMounted, onBeforeUnmount })) vi.stubGlobal(name, value)
let emit: (event: unknown) => void
vi.stubGlobal('useLive', () => ({ state: ref({ agents: [] }), subscribe: (fn: typeof emit) => {
  emit = fn
  return () => {}
} }))
const { useProjectOverview } = await import('./useProjectOverview')

const project = { id: 'p1', slug: 'corral' } as Project
const task = (id: string) => ({ id, number: 1, updatedAt: '2026-10-01' }) as Task

const cleanups: (() => void)[] = []
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup()
})

function setup(initiallyOpen: boolean, initiallyLoading = false) {
  const open = ref(initiallyOpen)
  const tasks = ref([task('a')])
  const loading = ref(initiallyLoading)
  let overview!: ReturnType<typeof useProjectOverview>
  const wrapper = mount({
    setup() {
      overview = useProjectOverview({ slug: computed(() => 'corral'), project: computed(() => project), tasks: computed(() => tasks.value), epics: computed(() => []), loading: computed(() => loading.value), error: computed(() => null), open: () => open.value })
      return () => null
    }
  })
  cleanups.push(() => wrapper.unmount())
  return { open, tasks, loading, overview, wrapper }
}
const loads = () => api.inbox.get.mock.calls.length

beforeEach(() => {
  vi.clearAllMocks()
  api.inbox.get.mockResolvedValue({})
  api.runs.list.mockResolvedValue([])
  api.tasks.history.mockResolvedValue([])
})

it('loads once for the project and not again on coming back unchanged', async () => {
  const { open } = setup(false)
  await flushPromises()
  expect(loads()).toBe(1)
  open.value = true
  await nextTick()
  open.value = false
  await nextTick()
  open.value = true
  await flushPromises()
  expect(loads()).toBe(1)
})

it('holds changes while closed and catches up once on opening', async () => {
  const { open, tasks } = setup(false)
  await flushPromises()
  tasks.value = [task('b')]
  emit({ type: 'run.updated', run: { projectId: 'p1' } })
  await flushPromises()
  expect(loads()).toBe(1)
  open.value = true
  await flushPromises()
  expect(loads()).toBe(2)
})

it('stays live while open', async () => {
  const { tasks } = setup(true)
  await flushPromises()
  tasks.value = [task('b')]
  await flushPromises()
  expect(loads()).toBe(2)
})

it('waits for the project lists before loading activity', async () => {
  const { loading } = setup(true, true)
  await flushPromises()
  expect(loads()).toBe(0)
  loading.value = false
  await flushPromises()
  expect(loads()).toBe(1)
})

it('ignores an older activity response that finishes after a newer load', async () => {
  let finish!: (entries: unknown[]) => void
  api.tasks.history.mockReturnValueOnce(new Promise((resolve) => {
    finish = resolve
  }))
  const { tasks, overview } = setup(true)
  await flushPromises()
  tasks.value = [task('b')]
  const newest = { id: 'new', createdAt: '2026-10-31' }
  api.tasks.history.mockResolvedValueOnce([newest])
  await flushPromises()
  expect(overview.history.value).toEqual([newest])
  finish([{ id: 'old', createdAt: '2026-10-30' }])
  await flushPromises()
  expect(overview.history.value).toEqual([newest])
})
