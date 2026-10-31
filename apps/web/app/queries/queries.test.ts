// @vitest-environment happy-dom
import { useMutation, useQuery } from '@tanstack/vue-query'
import type { Agent, Epic, Project, Run, ServerEvent, Task } from '@corral/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h, nextTick, ref } from 'vue'
import { useLive } from '~/composables/useLive'
import { ApiError, api } from '~/composables/useApi'
import type { eventDependencies } from './dependencies'
import { applyEvent, defineMutation, serverEventTypes } from './dependencies'
import { createQueryClient } from './client'
import { keys } from './keys'
import { createAgent } from './agents'
import { connectQueries, MAX_WAIT_MS, QUIET_MS } from './live'
import { mountWithQuery, testQueryClient } from './mount-with-query'
import { removeProject } from './projects'
import { clisQuery, refreshRepos, reposQuery } from './setup'

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

describe('run transcripts', () => {
  const line = (text: string) => ({ type: 'system', text }) as const
  const lines = (...texts: string[]) => texts.map(line)
  const key = keys.runs.transcript('r1')
  const event = (offset: number, ...texts: string[]): ServerEvent => ({ type: 'run.events', runId: 'r1', offset, events: lines(...texts) })
  const stale = (client: ReturnType<typeof testQueryClient>, e: ServerEvent) => applyEvent(client, e)

  it('appends a line at the end, active or not', () => {
    const client = testQueryClient()
    client.setQueryData(key, lines('a'))
    expect(stale(client, event(1, 'b', 'c'))).toEqual([])
    expect(client.getQueryData(key)).toEqual(lines('a', 'b', 'c'))
  })

  it('skips lines a fetch already returned, keeping any new ones in the same event', () => {
    const client = testQueryClient()
    client.setQueryData(key, lines('a', 'b'))
    expect(stale(client, event(0, 'a'))).toEqual([])
    expect(client.getQueryData(key)).toEqual(lines('a', 'b'))
    expect(stale(client, event(1, 'b', 'c'))).toEqual([])
    expect(client.getQueryData(key)).toEqual(lines('a', 'b', 'c'))
  })

  it('refetches rather than leave a gap, and doesn\'t mark a stale transcript fresh', async () => {
    const client = testQueryClient()
    client.setQueryData(key, lines('a'))
    await client.invalidateQueries({ queryKey: key })
    expect(stale(client, event(3, 'd'))).toEqual([key])
    expect(client.getQueryData(key)).toEqual(lines('a'))
    expect(client.getQueryState(key)?.isInvalidated).toBe(true)
  })

  it('starts nothing for a transcript nobody has loaded, and retries one that failed', () => {
    const client = testQueryClient()
    expect(stale(client, event(0, 'a'))).toEqual([key])
    expect(client.getQueryData(key)).toBeUndefined()
  })

  it('keeps a run going through switching away and back without a gap or duplicate', async () => {
    const client = testQueryClient()
    const server = lines('a', 'b')
    const queryFn = vi.fn(async () => [...server])
    const view = defineComponent({ setup() {
      const query = useQuery({ queryKey: key, queryFn })
      return () => h('p', query.data.value?.map(l => l.text).join('') ?? 'empty')
    } })
    const first = mountWithQuery(view, { client })
    await vi.waitFor(() => expect(first.wrapper.text()).toBe('ab'))
    const emitLine = async (text: string, delivered = true) => {
      const offset = server.length
      server.push(line(text))
      if (delivered) stale(client, event(offset, text))
    }
    await emitLine('c')
    await nextTick()
    expect(first.wrapper.text()).toBe('abc')
    first.wrapper.unmount()
    await emitLine('d')
    const back = mountWithQuery(view, { client })
    expect(back.wrapper.text()).toBe('abcd')
    await emitLine('e')
    await nextTick()
    expect(back.wrapper.text()).toBe('abcde')
    back.wrapper.unmount()
  })
})

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

  it('keeps read-only Inbox events out of refetches and writes the count into the cache', async () => {
    useLive().connect()
    const inbox = onScreen(client, keys.inbox(), () => ({ count: 2, needsYou: [] }))
    await vi.advanceTimersByTimeAsync(0)
    FakeEventSource.last.emit('plan.session', {
      type: 'plan.session', session: { id: 's-1', unread: false }, markedRead: { inboxCount: 1 }
    })
    FakeEventSource.last.emit('deployment.updated', { type: 'deployment.updated', deployment: { id: 'd-1' }, markedRead: true })
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + QUIET_MS)
    expect(client.getQueryData(keys.inbox())).toEqual({ count: 1, needsYou: [] })
    expect(inbox.queryFn).toHaveBeenCalledTimes(1)
    // Content changes still invalidate the derived Inbox, as on main.
    FakeEventSource.last.emit('deployment.updated', { type: 'deployment.updated' })
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS + QUIET_MS)
    expect(inbox.queryFn).toHaveBeenCalledTimes(2)
    inbox.wrapper.unmount()
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

  it('refetches a task\'s history, evidence and reviews when one of its runs changes', () => {
    client.setQueryData(keys.projects.list(), [{ id: 'p-1', slug: 'corral' }])
    const stale = applyEvent(client, { type: 'run.updated', run: { id: 'r-1', agentId: 'a-1', projectId: 'p-1', taskRef: 'COR-1' } as Extract<ServerEvent, { type: 'run.updated' }>['run'] })
    for (const key of [keys.tasks.history('COR-1'), keys.tasks.evidence('COR-1'), keys.tasks.reviews('COR-1'), keys.tasks.designs('COR-1')]) expect(stale).toContainEqual(key)
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

vi.mock('~/composables/useApi', async original => ({ ...await original<typeof import('~/composables/useApi')>(), api: {
  agents: { list: vi.fn(), create: vi.fn() },
  projects: { list: vi.fn(), remove: vi.fn() },
  setup: { clis: vi.fn(), repos: vi.fn() }
} }))

// Mounts a mutation's useMutation and hands back its mutateAsync
function mutation<D, V>(definition: Parameters<typeof useMutation<D, Error, V>>[0], client: ReturnType<typeof testQueryClient>) {
  let mutate!: (variables: V) => Promise<D>
  mountWithQuery(defineComponent({ setup() {
    mutate = useMutation(definition).mutateAsync
    return () => h('div')
  } }), { client })
  return mutate
}

describe('a new agent', () => {
  const orion = { id: 'a-2', name: 'Orion' } as Agent
  const juno = { id: 'a-1', name: 'Juno' } as Agent
  function listed() {
    const client = testQueryClient()
    client.setQueryData(keys.agents.list(), [juno])
    onScreen(client, keys.agents.list(), () => server)
    return client
  }
  let server: Agent[] = []
  beforeEach(() => {
    server = [juno]
    vi.mocked(api.agents.create).mockImplementation(async () => {
      server = [juno, orion]
      return orion
    })
  })
  const event = { type: 'agent.updated', agent: orion } as ServerEvent

  it('is listed once with no event at all', async () => {
    const client = listed()
    await mutation(createAgent, client)(orion as never)
    expect(client.getQueryData(keys.agents.list())).toEqual([juno, orion])
  })
  it('is listed once when the event comes after the response', async () => {
    const client = listed()
    await mutation(createAgent, client)(orion as never)
    applyEvent(client, event)
    expect(client.getQueryData(keys.agents.list())).toEqual([juno, orion])
  })
  it('is listed once when the event beats the response', async () => {
    const client = listed()
    applyEvent(client, event)
    await mutation(createAgent, client)(orion as never)
    expect(client.getQueryData(keys.agents.list())).toEqual([juno, orion])
  })
})

describe('removing a project', () => {
  const gone = { id: 'p-1', slug: 'corral', name: 'Corral' } as Project
  const kept = { id: 'p-2', slug: 'other', name: 'Other' } as Project
  const goneRun = { id: 'r-1', projectId: 'p-1' } as Run
  const keptRun = { id: 'r-2', projectId: 'p-2' } as Run
  const session = (id: string, projectId: string) => ({ id, projectId })
  function cached() {
    const client = testQueryClient()
    client.setQueryData(keys.projects.list(), [gone, kept])
    client.setQueryData(keys.projects.detail('corral'), gone)
    client.setQueryData(keys.projects.flow('corral', '30d'), {})
    client.setQueryData(keys.projects.pullRequests('corral'), [])
    client.setQueryData(keys.tasks.list('corral'), [task()])
    client.setQueryData(keys.tasks.detail('COR-1'), task())
    client.setQueryData(keys.tasks.comments('COR-1'), [])
    client.setQueryData(keys.tasks.detail('COR-2'), task({ id: 't-2', ref: 'COR-2' }))
    client.setQueryData(keys.epics.list('corral'), [])
    client.setQueryData(keys.epics.detail('e-1'), { id: 'e-1', projectId: 'p-1' } as Epic)
    client.setQueryData(keys.runs.detail('r-1'), goneRun)
    client.setQueryData(keys.runs.transcript('r-1'), [])
    client.setQueryData(keys.runs.list({ active: true }), [goneRun, keptRun])
    client.setQueryData(keys.plan.sessions(), [session('s-1', 'p-1'), session('s-2', 'p-2')])
    client.setQueryData(keys.plan.session('s-1'), session('s-1', 'p-1'))
    client.setQueryData(keys.plan.drafts('corral'), [])
    client.setQueryData(keys.tasks.list('other'), [task({ id: 't-9', ref: 'OTH-1', projectId: 'p-2' })])
    client.setQueryData(keys.runs.detail('r-2'), keptRun)
    return client
  }
  function expectCleared(client: ReturnType<typeof testQueryClient>) {
    const left = client.getQueryCache().getAll().map(query => JSON.stringify(query.queryKey))
    expect(left.sort()).toEqual([keys.projects.list(), keys.runs.list({ active: true }), keys.plan.sessions(), keys.tasks.list('other'), keys.runs.detail('r-2')].map(key => JSON.stringify(key)).sort())
    expect(client.getQueryData(keys.projects.list())).toEqual([kept])
    expect(client.getQueryData(keys.runs.list({ active: true }))).toEqual([keptRun])
    expect(client.getQueryData(keys.plan.sessions())).toEqual([session('s-2', 'p-2')])
  }

  it('clears everything cached for it on the response, with no event', async () => {
    vi.mocked(api.projects.remove).mockResolvedValue(null as never)
    const client = cached()
    await mutation(removeProject, client)({ id: 'p-1', slug: 'corral', confirm: 'Corral' })
    expectCleared(client)
  })
  it('marks the repository list stale, whose rows name the project', async () => {
    vi.mocked(api.projects.remove).mockResolvedValue(null as never)
    const client = cached()
    client.setQueryData(keys.setup.repos(), { signedIn: true, repos: [] })
    await mutation(removeProject, client)({ id: 'p-1', slug: 'corral', confirm: 'Corral' })
    expect(client.getQueryState(keys.setup.repos())?.isInvalidated).toBe(true)
    client.setQueryData(keys.setup.repos(), { signedIn: true, repos: [] })
    expect(applyEvent(client, { type: 'project.deleted', projectId: 'p-1' })).toContainEqual(keys.setup.repos())
    expect(applyEvent(client, { type: 'project.created', project: gone })).toContainEqual(keys.setup.repos())
  })
  it('takes the data off a page still showing it and refetches to the 404', async () => {
    const client = cached()
    let found = true
    const queryFn = vi.fn(async () => {
      if (!found) throw new ApiError(404, { code: 'not_found' } as never, 'Not found')
      return session('s-1', 'p-1')
    })
    const { wrapper } = mountWithQuery(defineComponent({ setup() {
      const query = useQuery({ queryKey: keys.plan.session('s-1'), queryFn, staleTime: Infinity })
      return () => h('div', query.error.value?.message ?? (query.data.value ? 'data' : 'nothing'))
    } }), { client })
    expect(wrapper.text()).toBe('data')
    found = false
    applyEvent(client, { type: 'project.deleted', projectId: 'p-1' })
    await vi.waitFor(() => expect(wrapper.text()).toBe('Not found'))
  })
  it('clears the same from the event alone', () => {
    const client = cached()
    applyEvent(client, { type: 'project.deleted', projectId: 'p-1' })
    expectCleared(client)
  })
  it('is settled whichever of event and response comes second', async () => {
    vi.mocked(api.projects.remove).mockResolvedValue(null as never)
    const client = cached()
    applyEvent(client, { type: 'project.deleted', projectId: 'p-1' })
    await mutation(removeProject, client)({ id: 'p-1', slug: 'corral', confirm: 'Corral' })
    expectCleared(client)
  })
})

describe('setup data', () => {
  it('shows the last CLI scan at once on a return and rescans behind it', async () => {
    const client = testQueryClient()
    vi.mocked(api.setup.clis).mockResolvedValueOnce([{ id: 'claude', signedIn: false }] as never)
    const shown: unknown[] = []
    const visit = () => mountWithQuery(defineComponent({ setup() {
      const scan = useQuery(clisQuery())
      shown.push({ pending: scan.isPending.value, data: scan.data.value })
      return () => h('div', String(scan.data.value?.[0]?.signedIn))
    } }), { client }).wrapper
    const first = visit()
    await vi.waitFor(() => expect(first.text()).toBe('false'))
    first.unmount()
    let finish!: (value: never) => void
    vi.mocked(api.setup.clis).mockReturnValueOnce(new Promise((resolve) => {
      finish = resolve
    }))
    const second = visit()
    expect(shown.at(-1)).toEqual({ pending: false, data: [{ id: 'claude', signedIn: false }] })
    expect(second.text()).toBe('false')
    expect(api.setup.clis).toHaveBeenCalledTimes(2)
    finish([{ id: 'claude', signedIn: true }] as never)
    await vi.waitFor(() => expect(second.text()).toBe('true'))
  })
  it('refreshes repositories into the one cached list', async () => {
    const client = testQueryClient()
    const before = { signedIn: true, repos: [] }
    const after = { signedIn: true, repos: [{ nameWithOwner: 'a/b' }] }
    client.setQueryData(reposQuery().queryKey, before as never)
    vi.mocked(api.setup.repos).mockResolvedValue(after as never)
    await mutation(refreshRepos, client)()
    expect(api.setup.repos).toHaveBeenCalledWith(true)
    expect(client.getQueryData(keys.setup.repos())).toEqual(after)
    expect(client.getQueryCache().getAll()).toHaveLength(1)
  })
})
