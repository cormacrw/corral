// @vitest-environment happy-dom
import { useMutation, useQuery } from '@tanstack/vue-query'
import type { ServerEvent, Task } from '@corral/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { useLive } from '~/composables/useLive'
import { ApiError } from '~/composables/useApi'
import type { eventDependencies } from './dependencies'
import { applyEvent, defineMutation, serverEventTypes } from './dependencies'
import { createQueryClient } from './client'
import { keys } from './keys'
import { connectQueries, MAX_WAIT_MS, QUIET_MS } from './live'
import { mountWithQuery, testQueryClient } from './mount-with-query'

// @ts-expect-error A type missing from the map must not compile
const incomplete: typeof eventDependencies = { 'deployment.updated': { invalidates: () => [] } }

class FakeEventSource {
  static last: FakeEventSource
  handlers = new Map<string, (message: unknown) => void>()
  onerror: (() => void) | null = null
  constructor() {
    FakeEventSource.last = this
  }

  addEventListener(type: string, handler: (message: unknown) => void) {
    this.handlers.set(type, handler)
  }

  close() {}
  emit(type: string, data: unknown = {}) {
    this.handlers.get(type)?.({ data: JSON.stringify(data) })
  }
}

const project = { id: 'p-1', slug: 'corral' }
const task = (over: Partial<Task> = {}) => ({ id: 't-1', ref: 'COR-1', number: 1, projectId: 'p-1', epicId: null, status: 'ready', title: 'One', ...over }) as Task

// Counts the fetches of a query mounted on screen, with what it showed
function onScreen(client: ReturnType<typeof testQueryClient>, queryKey: readonly unknown[], data: () => unknown) {
  const queryFn = vi.fn(async () => data())
  const shown: boolean[] = []
  const { wrapper } = mountWithQuery(defineComponent({ setup() {
    const query = useQuery({ queryKey, queryFn, staleTime: Infinity })
    return () => {
      shown.push(query.isPending.value)
      return h('div', query.isPending.value ? 'skeleton' : 'content')
    }
  } }), { client })
  return { queryFn, shown, wrapper }
}

describe('query layer', () => {
  let client: ReturnType<typeof testQueryClient>
  let stop: () => void

  beforeEach(() => {
    vi.useFakeTimers()
    vi.stubGlobal('EventSource', FakeEventSource)
    vi.stubGlobal('useRoute', () => ({ params: {} }))
    vi.stubGlobal('usePendingPlan', () => ({ apply: () => {} }))
    vi.stubGlobal('useState', (_key: string, init: () => unknown) => ref(init()))
    vi.stubGlobal('fetch', vi.fn(async () => new Response('[]')))
    client = testQueryClient()
    client.setQueryData(keys.projects.list(), [project])
    stop = connectQueries(client)
  })
  afterEach(() => {
    stop()
    client.clear()
    vi.useRealTimers()
    vi.unstubAllGlobals()
  })

  it('subscribes the stream to every event in the map', () => {
    expect(incomplete).toBeDefined()
    useLive().connect()
    expect([...FakeEventSource.last.handlers.keys()]).toEqual(expect.arrayContaining(serverEventTypes))
  })

  it('coalesces a burst of task events into one refetch of each affected query', async () => {
    const live = useLive()
    live.connect()
    const inbox = onScreen(client, keys.inbox(), () => ({ count: 0 }))
    const history = onScreen(client, keys.tasks.history('COR-1'), () => [])
    const list = onScreen(client, keys.tasks.list('corral'), () => [task()])
    const unrelated = onScreen(client, keys.agents.list(), () => [])
    await vi.advanceTimersByTimeAsync(0)
    for (const q of [inbox, history, list, unrelated]) expect(q.queryFn).toHaveBeenCalledTimes(1)

    for (let i = 0; i < 20; i++) {
      FakeEventSource.last.emit('task.updated', { type: 'task.updated', task: task({ title: `v${i}` }) })
      await vi.advanceTimersByTimeAsync(49)
    }
    await vi.advanceTimersByTimeAsync(QUIET_MS)

    expect(inbox.queryFn).toHaveBeenCalledTimes(2)
    expect(history.queryFn).toHaveBeenCalledTimes(2)
    // Written from the event, so nothing to fetch
    expect(list.queryFn).toHaveBeenCalledTimes(1)
    expect(client.getQueryData<Task[]>(keys.tasks.list('corral'))?.[0]?.title).toBe('v19')
    expect(unrelated.queryFn).toHaveBeenCalledTimes(1)
    for (const q of [inbox, history, list, unrelated]) q.wrapper.unmount()
  })

  it.each([
    ['two groups with a long pause', [...Array(10).keys()].flatMap(i => [i * 10, 600 + i * 10])],
    ['the first and last event a second apart', [0, ...Array(19).fill(999)]]
  ])('keeps an interrupted burst to one refetch: %s', async (_name, times: number[]) => {
    const inbox = onScreen(client, keys.inbox(), () => ({ count: 0 }))
    await vi.advanceTimersByTimeAsync(0)
    const start = Date.now()
    for (const at of times.toSorted((a, b) => a - b)) {
      await vi.advanceTimersByTimeAsync(start + at - Date.now())
      FakeEventSource.last.emit('task.updated', { type: 'task.updated', task: task() })
    }
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS)
    expect(inbox.queryFn).toHaveBeenCalledTimes(2)
    inbox.wrapper.unmount()
  })

  it('refetches once when overlapping keys cover the same query', async () => {
    const comments = onScreen(client, keys.tasks.comments('COR-1'), () => [])
    await vi.advanceTimersByTimeAsync(0)
    FakeEventSource.last.emit('task.deleted', { type: 'task.deleted', taskId: 't-2', projectId: 'p-other' })
    FakeEventSource.last.emit('comment.created', { type: 'comment.created', comment: { id: 'c', taskId: 'unknown' } })
    await vi.advanceTimersByTimeAsync(QUIET_MS)
    expect(comments.queryFn).toHaveBeenCalledTimes(2)
    comments.wrapper.unmount()
  })

  it('refetches during endless traffic instead of waiting for a quiet moment', async () => {
    const inbox = onScreen(client, keys.inbox(), () => ({ count: 0 }))
    await vi.advanceTimersByTimeAsync(0)
    for (let elapsed = 0; elapsed < MAX_WAIT_MS; elapsed += 100) {
      FakeEventSource.last.emit('deployment.updated', { type: 'deployment.updated' })
      await vi.advanceTimersByTimeAsync(100)
    }
    expect(inbox.queryFn).toHaveBeenCalledTimes(2)
    inbox.wrapper.unmount()
  })

  it('refetches every query on screen after a reconnect without showing loading', async () => {
    const live = useLive()
    live.state.value.connection = 'open'
    const a = onScreen(client, keys.inbox(), () => ({ count: 0 }))
    const b = onScreen(client, keys.agents.list(), () => [])
    await vi.advanceTimersByTimeAsync(0)
    await nextTick()
    const before = a.shown.length

    const dropped = FakeEventSource.last
    dropped.onerror?.()
    await vi.advanceTimersByTimeAsync(1000)
    expect(FakeEventSource.last).not.toBe(dropped)
    FakeEventSource.last.emit('ready')
    await vi.advanceTimersByTimeAsync(0)

    expect(a.queryFn).toHaveBeenCalledTimes(2)
    expect(b.queryFn).toHaveBeenCalledTimes(2)
    expect(a.shown.slice(before)).not.toContain(true)
    expect(a.wrapper.text()).toBe('content')
    a.wrapper.unmount()
    b.wrapper.unmount()
  })

  it('leaves cached data alone when a mutation fails, and rejects to the caller', async () => {
    const inbox = onScreen(client, keys.inbox(), () => ({ count: 0 }))
    await vi.advanceTimersByTimeAsync(0)
    const failure = new ApiError(409, null, 'Conflict')
    let mutation!: ReturnType<typeof useMutation<unknown, Error, void>>
    const { wrapper } = mountWithQuery(defineComponent({ setup() {
      mutation = useMutation(defineMutation<unknown>({ mutationFn: () => Promise.reject(failure), invalidates: [keys.inbox()] }))
      return () => h('div')
    } }), { client })

    await expect(mutation.mutateAsync()).rejects.toBe(failure)
    await vi.advanceTimersByTimeAsync(QUIET_MS)

    expect(mutation.error.value).toBe(failure)
    expect(inbox.queryFn).toHaveBeenCalledTimes(1)
    expect(client.getQueryState(keys.inbox())?.isInvalidated).toBe(false)
    wrapper.unmount()
    inbox.wrapper.unmount()
  })

  it('invalidates at once on mutation success, with keys from the result', async () => {
    const inbox = onScreen(client, keys.inbox(), () => ({ count: 0 }))
    await vi.advanceTimersByTimeAsync(0)
    let mutation!: ReturnType<typeof useMutation<string, Error, number>>
    const invalidates = vi.fn(() => [keys.inbox()])
    const { wrapper } = mountWithQuery(defineComponent({ setup() {
      mutation = useMutation(defineMutation<string, number>({ mutationFn: async n => `done ${n}`, invalidates }))
      return () => h('div')
    } }), { client })

    await mutation.mutateAsync(1)

    expect(invalidates).toHaveBeenCalledWith('done 1', 1)
    expect(inbox.queryFn).toHaveBeenCalledTimes(2)
    wrapper.unmount()
    inbox.wrapper.unmount()
  })

  it('refetches after a write that raced a fetch in flight', async () => {
    client.setQueryData(keys.tasks.list('corral'), [task()])
    let release!: (tasks: Task[]) => void
    void client.fetchQuery({ queryKey: keys.tasks.list('corral'), queryFn: () => new Promise<Task[]>((resolve) => {
      release = resolve
    }) })
    await vi.advanceTimersByTimeAsync(0)
    const stale = applyEvent(client, { type: 'task.updated', task: task({ title: 'new' }) })
    expect(stale).toContainEqual(keys.tasks.list('corral'))
    release([])
  })

  it('keeps drafts out of task lists and adds tasks only to loaded lists', () => {
    client.setQueryData(keys.tasks.list('corral'), [task()])
    applyEvent(client, { type: 'task.updated', task: task({ status: 'draft' }) })
    expect(client.getQueryData(keys.tasks.list('corral'))).toEqual([])
    applyEvent(client, { type: 'task.created', task: task({ id: 't-2', ref: 'COR-2' }) })
    expect(client.getQueryData<Task[]>(keys.tasks.list('corral'))).toHaveLength(1)
    expect(client.getQueryData(keys.tasks.detail('COR-2'))).toBeUndefined()
  })

  it('treats every project\'s lists as stale when the project is not cached', () => {
    const stale = applyEvent(client, { type: 'task.updated', task: task({ projectId: 'p-unknown' }) })
    expect(stale).toContainEqual(keys.tasks.lists())
    expect(stale).toContainEqual(keys.projects.all())
  })

  it('appends a comment to the comments of a task found in the cache', () => {
    client.setQueryData(keys.tasks.list('corral'), [task()])
    client.setQueryData(keys.tasks.comments('COR-1'), [])
    const comment = { id: 'c-1', taskId: 't-1' } as Extract<ServerEvent, { type: 'comment.created' }>['comment']
    applyEvent(client, { type: 'comment.created', comment })
    applyEvent(client, { type: 'comment.created', comment })
    expect(client.getQueryData(keys.tasks.comments('COR-1'))).toEqual([comment])
  })

  it('uses defaults that show cached data at once and do not retry a 4xx', () => {
    const defaults = createQueryClient().getDefaultOptions().queries!
    expect(defaults.staleTime).toBeGreaterThan(0)
    expect(defaults.networkMode).toBe('always')
    const retry = defaults.retry as (failures: number, error: Error) => boolean
    expect(retry(0, new ApiError(404, null, 'Not found'))).toBe(false)
    expect(retry(0, new ApiError(503, null, 'Down'))).toBe(true)
    expect(retry(2, new Error('network'))).toBe(false)
  })
})
