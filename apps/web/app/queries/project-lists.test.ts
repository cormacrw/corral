// @vitest-environment happy-dom
import { useMutation } from '@tanstack/vue-query'
import type { Project, Task } from '@corral/contracts'
import { defineComponent, h, nextTick, ref } from 'vue'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { api } from '~/composables/useApi'
import { useAllProjectLists, useProjectLists } from '~/composables/useProjectLists'
import { applyEvent } from './dependencies'
import { keys } from './keys'
import { mountWithQuery, testQueryClient } from './mount-with-query'
import { moveTask, tasksQuery } from './tasks'

const project = { id: 'p1', slug: 'test-app' } as Project
const task = (over: Partial<Task> = {}) => ({ id: 't1', ref: 'TA-1', number: 1, projectId: 'p1', status: 'blocked', title: 'Card', updatedAt: '2026-10-31T00:00:00Z', ...over }) as Task

describe('shared project lists', () => {
  let client: ReturnType<typeof testQueryClient>
  beforeEach(() => {
    client = testQueryClient()
    client.setDefaultOptions({ queries: { staleTime: 30_000, retry: false, gcTime: Infinity } })
    client.setQueryData(keys.projects.list(), [project])
    client.setQueryData(keys.tasks.list(project.slug), [task()])
    client.setQueryData(keys.epics.list(project.slug), [])
  })
  afterEach(() => {
    client.clear()
    vi.restoreAllMocks()
  })

  it('shares the shell cache across page mounts without a pending render', async () => {
    const fetchTasks = vi.spyOn(api.tasks, 'list').mockResolvedValue([task()])
    vi.spyOn(api.epics, 'list').mockResolvedValue([])
    const shell = mountWithQuery(defineComponent({ setup() {
      useAllProjectLists([project])
      return () => h('div')
    } }), { client })
    const pending: boolean[] = []
    const Page = defineComponent({ setup() {
      const lists = useProjectLists(project.slug)
      return () => {
        pending.push(lists.loading.value)
        return h('div', lists.tasks.value.map(t => t.ref).join(','))
      }
    } })
    for (let i = 0; i < 3; i++) {
      const page = mountWithQuery(Page, { client })
      expect(page.wrapper.text()).toBe('TA-1')
      await flushPromises()
      page.wrapper.unmount()
    }
    expect(pending.every(value => !value)).toBe(true)
    expect(fetchTasks).not.toHaveBeenCalled()
    shell.wrapper.unmount()
  })

  it.each(['tasks', 'epics'] as const)('keeps cached content after a failed %s background refetch', async (domain) => {
    vi.spyOn(api.tasks, 'list').mockImplementation(async () => {
      if (domain === 'tasks') throw new Error('502')
      return [task()]
    })
    vi.spyOn(api.epics, 'list').mockImplementation(async () => {
      if (domain === 'epics') throw new Error('502')
      return []
    })
    let lists!: ReturnType<typeof useProjectLists>
    const page = mountWithQuery(defineComponent({ setup() {
      lists = useProjectLists(project.slug)
      return () => h('div', lists.error.value ?? (lists.loading.value ? 'skeleton' : lists.tasks.value.map(t => t.ref).join(',')))
    } }), { client })
    await client.invalidateQueries()
    await flushPromises()
    // Confirm a real refetch error, including the cached empty epic list.
    expect(client.getQueryState(keys[domain].list(project.slug))?.error?.message).toBe('502')
    expect(lists.error.value).toBeNull()
    expect(lists.loading.value).toBe(false)
    expect(page.wrapper.text()).toBe('TA-1')
    // Re-entering Board/Backlog/Overview mustn't expose the retained error.
    page.wrapper.unmount()
    const revisit = mountWithQuery(defineComponent({ setup() {
      const lists = useProjectLists(project.slug)
      return () => h('div', lists.error.value ?? (lists.loading.value ? 'skeleton' : lists.tasks.value.map(t => t.ref).join(',')))
    } }), { client })
    expect(revisit.wrapper.text()).toBe('TA-1')
    await flushPromises()
    revisit.wrapper.unmount()
  })

  it.each(['tasks', 'epics'] as const)('still exposes a %s cold-load failure without cached data', async (domain) => {
    client.removeQueries({ queryKey: keys[domain].list(project.slug) })
    vi.spyOn(api.tasks, 'list').mockRejectedValue(new Error('502'))
    vi.spyOn(api.epics, 'list').mockRejectedValue(new Error('502'))
    let lists!: ReturnType<typeof useProjectLists>
    const page = mountWithQuery(defineComponent({ setup() {
      lists = useProjectLists(project.slug)
      return () => h('div', lists.error.value ?? '')
    } }), { client })
    await flushPromises()
    expect(lists.error.value).toBe('502')
    expect(lists.loading.value).toBe(false)
    expect(page.wrapper.text()).toBe('502')
    page.wrapper.unmount()
  })

  it('writes agent moves to every observer and removes drafts and deleted projects from search', async () => {
    const projects = ref([project])
    let lists!: ReturnType<typeof useAllProjectLists>
    const shell = mountWithQuery(defineComponent({ setup() {
      lists = useAllProjectLists(projects)
      return () => h('div', Object.values(lists.tasks.value).flatMap(list => list ?? []).map(t => t.ref).join(','))
    } }), { client })
    const board = mountWithQuery(defineComponent({ setup() {
      const lists = useProjectLists(project.slug)
      return () => h('div', lists.tasks.value.map(t => t.status).join(','))
    } }), { client })
    applyEvent(client, { type: 'task.updated', task: task({ status: 'ready' }) })
    await flushPromises()
    expect(board.wrapper.text()).toBe('ready')
    expect(lists.tasks.value.p1?.filter(t => t.status === 'ready')).toHaveLength(1)
    applyEvent(client, { type: 'task.updated', task: task({ status: 'draft' }) })
    await flushPromises()
    expect(board.wrapper.text()).toBe('')
    expect(shell.wrapper.text()).toBe('')
    applyEvent(client, { type: 'task.created', task: task() })
    await flushPromises()
    expect(shell.wrapper.text()).toBe('TA-1')
    applyEvent(client, { type: 'project.deleted', projectId: project.id })
    projects.value = client.getQueryData<Project[]>(keys.projects.list())!
    await flushPromises()
    expect(shell.wrapper.text()).toBe('')
    expect(client.getQueryData(keys.tasks.list(project.slug))).toEqual([])
    board.wrapper.unmount()
    shell.wrapper.unmount()
  })

  it('keeps project identities correct while observers catch up with reordering or deletion', async () => {
    const second = { id: 'p2', slug: 'second' } as Project
    client.setQueryData(keys.tasks.list(second.slug), [task({ id: 't2', ref: 'TWO-1', projectId: second.id })])
    client.setQueryData(keys.epics.list(second.slug), [])
    const projects = ref([project, second])
    let lists!: ReturnType<typeof useAllProjectLists>
    const shell = mountWithQuery(defineComponent({ setup() {
      lists = useAllProjectLists(projects)
      return () => h('div')
    } }), { client })
    await flushPromises()
    projects.value = [second, project]
    expect(lists.tasks.value.p2?.[0]?.ref).toBe('TWO-1')
    expect(lists.tasks.value.p1?.[0]?.ref).toBe('TA-1')
    projects.value = [second]
    expect(lists.tasks.value.p1).toBeUndefined()
    expect(lists.tasks.value.p2?.[0]?.ref).toBe('TWO-1')
    await flushPromises()
    shell.wrapper.unmount()
  })

  it('never includes drafts in an initial list fetch', async () => {
    vi.spyOn(api.tasks, 'list').mockResolvedValue([task(), task({ id: 'draft', status: 'draft' })])
    expect(await client.fetchQuery({ ...tasksQuery('new-project') })).toEqual([task()])
  })

  it('moves immediately and rolls back only the rejected card, preserving other live changes', async () => {
    let reject!: (error: Error) => void
    vi.spyOn(api.tasks, 'transition').mockImplementation(() => new Promise((_resolve, fail) => {
      reject = fail
    }))
    client.setQueryData(keys.tasks.list(project.slug), [task(), task({ id: 't2', ref: 'TA-2', number: 2 })])
    let trigger!: (variables: Parameters<typeof moveTask.onMutate>[0]) => Promise<Task>
    let failure!: () => Error | null
    const page = mountWithQuery(defineComponent({ setup() {
      const move = useMutation(moveTask)
      // Keep the public call outside setup so assertions can inspect mid-flight.
      trigger = variables => move.mutateAsync(variables)
      failure = () => move.error.value
      return () => h('div')
    } }), { client })
    const result = trigger({ task: { ...task(), slug: project.slug }, input: { type: 'resolve', to: 'ready' }, status: 'ready' }).catch(error => error)
    await flushPromises()
    expect(client.getQueryData<Task[]>(keys.tasks.list(project.slug))?.[0]?.status).toBe('ready')
    applyEvent(client, { type: 'task.updated', task: task({ id: 't2', ref: 'TA-2', number: 2, status: 'in_progress' }) })
    reject(new Error('Server rejected the move'))
    expect((await result).message).toBe('Server rejected the move')
    await nextTick()
    expect(client.getQueryData<Task[]>(keys.tasks.list(project.slug))?.map(t => t.status)).toEqual(['blocked', 'in_progress'])
    expect(failure()?.message).toBe('Server rejected the move')
    page.wrapper.unmount()
  })

  it('does not roll back a newer event for the moved card', async () => {
    const variables = { task: { ...task(), slug: project.slug }, input: { type: 'resolve', to: 'ready' } as const, status: 'ready' as const }
    const context = await moveTask.onMutate(variables, { client })
    applyEvent(client, { type: 'task.updated', task: task({ status: 'in_progress', updatedAt: '2026-10-31T01:00:00Z' }) })
    moveTask.onError(new Error('Rejected'), variables, context, { client })
    expect(client.getQueryData<Task[]>(keys.tasks.list(project.slug))?.[0]?.status).toBe('in_progress')
  })
})
