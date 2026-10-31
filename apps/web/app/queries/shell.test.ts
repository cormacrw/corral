// @vitest-environment happy-dom
import type { ServerEvent } from '@corral/contracts'
import { flushPromises } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { effectScope, ref, watch } from 'vue'
import { api } from '~/composables/useApi'
import { createQueryClient } from './client'
import { applyEvent } from './dependencies'
import { connectQueries, MAX_WAIT_MS, QUIET_MS } from './live'
import { keys } from './keys'
import { reloadShell, shell, startShell } from './shell'

vi.mock('~/composables/useApi', async original => ({ ...await original<typeof import('~/composables/useApi')>(), api: {
  projects: { list: vi.fn() }, agents: { list: vi.fn() }, runner: vi.fn(), status: vi.fn(),
  me: { get: vi.fn() }, plan: { sessions: vi.fn() }, inbox: { get: vi.fn() }
} }))

// useLive with Nuxt's auto-imports stubbed
const pendingApply = vi.fn()
const eventSources: FakeEventSource[] = []
class FakeEventSource {
  handlers: Record<string, (message: { data: string }) => void> = {}
  onerror: (() => void) | null = null
  constructor() {
    eventSources.push(this)
  }

  addEventListener(type: string, handler: (message: { data: string }) => void) {
    this.handlers[type] = handler
  }

  close() {}
  emit(event: ServerEvent) {
    this.handlers[event.type]!({ data: JSON.stringify(event) })
  }
}
vi.stubGlobal('EventSource', FakeEventSource)
vi.stubGlobal('useRoute', () => ({ params: {} }))
vi.stubGlobal('usePendingPlan', () => ({ apply: pendingApply }))
const useState = vi.fn((_key: string, init: () => unknown) => ref(init()))
vi.stubGlobal('useState', useState)

const { useLive } = await import('~/composables/useLive')

const run = { id: 'r1', projectId: 'p1', taskId: 't1' }
const task = { id: 't1', ref: 'TA-1', projectId: 'p1', status: 'ready', epicId: null }

describe('shell queries', () => {
  let client: ReturnType<typeof createQueryClient>
  let stops: (() => void)[]

  beforeEach(() => {
    vi.useFakeTimers()
    vi.clearAllMocks()
    vi.mocked(api.projects.list).mockResolvedValue([{ id: 'p1', slug: 'test-app' }] as never)
    vi.mocked(api.agents.list).mockResolvedValue([{ id: 'a1', activeRuns: 0 }] as never)
    vi.mocked(api.runner).mockResolvedValue({ online: true } as never)
    vi.mocked(api.status).mockResolvedValue({ stopped: false, updating: false })
    vi.mocked(api.me.get).mockResolvedValue({ name: 'Sam' } as never)
    vi.mocked(api.plan.sessions).mockResolvedValue([])
    vi.mocked(api.inbox.get).mockResolvedValue({ count: 2 } as never)
    client = createQueryClient()
    stops = [startShell(client), connectQueries(client)]
  })
  afterEach(() => {
    stops.forEach(stop => stop())
    client.clear()
    vi.useRealTimers()
  })

  const loaded = async () => {
    await flushPromises()
    await vi.advanceTimersByTimeAsync(0)
  }

  it('reads through the useLive getters once every query has data', async () => {
    stops.shift()!()
    client.clear()
    let answer!: (status: never) => void
    vi.mocked(api.runner).mockReturnValue(new Promise((resolve) => {
      answer = resolve
    }))
    stops.unshift(startShell(client))
    const live = useLive()
    await loaded()
    expect(live.state.value.loaded).toBe(false)
    expect(live.state.value.runner).toBeNull()
    answer({ online: true } as never)
    await loaded()
    expect(live.state.value.loaded).toBe(true)
    expect(live.state.value.projects[0]!.slug).toBe('test-app')
    expect(live.state.value.inboxCount).toBe(2)
    expect(live.state.value.profile?.name).toBe('Sam')
  })

  it('updates getters from entity events at once', async () => {
    const live = useLive()
    await loaded()
    const seen = ref<boolean[]>([])
    const scope = effectScope()
    scope.run(() => watch(() => live.state.value.status.stopped, stopped => seen.value.push(stopped), { flush: 'sync' }))
    applyEvent(client, { type: 'global.status', status: { stopped: true, updating: false } })
    expect(live.state.value.status.stopped).toBe(true)
    expect(seen.value).toEqual([true])
    applyEvent(client, { type: 'runner.status', status: { online: false } } as ServerEvent)
    expect(live.state.value.runner?.online).toBe(false)
    applyEvent(client, { type: 'profile.updated', profile: { name: 'Robin' } } as ServerEvent)
    expect(live.state.value.profile?.name).toBe('Robin')
    scope.stop()
  })

  it('refetches agents and the inbox count once for a burst of events', async () => {
    const live = useLive()
    live.connect()
    await loaded()
    expect(api.agents.list).toHaveBeenCalledTimes(1)
    expect(api.inbox.get).toHaveBeenCalledTimes(1)
    vi.mocked(api.agents.list).mockResolvedValue([{ id: 'a1', activeRuns: 1 }] as never)
    vi.mocked(api.inbox.get).mockResolvedValue({ count: 3 } as never)

    const source = eventSources.at(-1)!
    for (let i = 0; i < 5; i++) source.emit({ type: 'run.updated', run } as ServerEvent)
    for (const type of ['task.created', 'task.updated'] as const) source.emit({ type, task } as ServerEvent)
    source.emit({ type: 'task.deleted', taskId: 't1', projectId: 'p1' })
    await vi.advanceTimersByTimeAsync(QUIET_MS)

    expect(api.agents.list).toHaveBeenCalledTimes(2)
    expect(api.inbox.get).toHaveBeenCalledTimes(2)
    expect(live.state.value.agents[0]!.activeRuns).toBe(1)
    expect(live.state.value.inboxCount).toBe(3)
    await vi.advanceTimersByTimeAsync(MAX_WAIT_MS)
    expect(api.agents.list).toHaveBeenCalledTimes(2)
  })

  it('hands plan events to usePendingPlan with no conversation mounted', async () => {
    useLive().connect()
    await loaded()
    const session = { id: 's1', unread: false }
    eventSources.at(-1)!.emit({ type: 'plan.session', session } as ServerEvent)
    expect(pendingApply).toHaveBeenCalledWith(expect.objectContaining({ type: 'plan.session', session }))
  })

  it('keeps loaded through a failed background refetch and reports the error', async () => {
    await loaded()
    vi.mocked(api.runner).mockRejectedValue(new Error('down'))
    const reload = reloadShell()
    await vi.advanceTimersByTimeAsync(10_000)
    await reload
    expect(shell()!.loaded.value).toBe(true)
    expect(shell()!.error.value).toBe('down')
  })

  it('asks for nothing while the data is fresh, however many read it', async () => {
    await loaded()
    for (let i = 0; i < 5; i++) useLive().state.value.projects.find(p => p.id === 'p1')
    await client.fetchQuery({ queryKey: keys.projects.list(), queryFn: api.projects.list })
    expect(api.projects.list).toHaveBeenCalledTimes(1)
  })
})
