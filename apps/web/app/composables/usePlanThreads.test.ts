// @vitest-environment happy-dom
import { VueQueryPlugin } from '@tanstack/vue-query'
import { testQueryClient } from '~/queries/mount-with-query'
import { keys } from '~/queries/keys'
import { api } from '~/composables/useApi'
import { mount } from '@vue/test-utils'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { Ref } from 'vue'
import { computed, defineComponent, effectScope, h, nextTick, reactive, ref, watch } from 'vue'
import type { PlanSession } from '@corral/contracts'

vi.mock('~/composables/useApi', () => ({ api: { plan: { sessions: vi.fn() } } }))

const session = (id: string, closed = false): PlanSession => ({
  id, closed, projectId: 'p-1', title: id, preview: '', runtime: 'codex',
  unread: false, status: 'none', activeRunId: null, createdAt: '', updatedAt: ''
})

describe('open Plan threads', () => {
  let client = testQueryClient()
  let state: Ref<{ loaded: boolean, planSessions: PlanSession[] }>
  let route: { params: { sessionId?: string } }
  let stored: Ref<string[]>
  const wrappers: ReturnType<typeof mount>[] = []

  beforeEach(() => {
    vi.resetModules()
    client = testQueryClient()
    state = ref({ loaded: false, planSessions: [session('a'), session('b'), session('closed', true)] })
    vi.mocked(api.plan.sessions).mockImplementation(() => new Promise(() => {}))
    watch(() => state.value.planSessions, sessions => client.setQueryData(keys.plan.sessions(), sessions), { flush: 'sync' })
    watch(() => state.value.loaded, (loaded) => {
      if (loaded) client.setQueryData(keys.plan.sessions(), state.value.planSessions)
    }, { flush: 'sync' })
    route = reactive({ params: {} })
    stored = ref(['a', 'b', 'missing', 'closed'])
    vi.stubGlobal('computed', computed)
    vi.stubGlobal('watch', watch)
    vi.stubGlobal('effectScope', effectScope)
    vi.stubGlobal('useLocalStorage', (key: string) => {
      expect(key).toBe('corral.plan.tabs')
      return stored
    })
    vi.stubGlobal('usePendingPlan', () => ({ entries: ref({}) }))
    vi.stubGlobal('useLive', () => ({ state }))
    vi.stubGlobal('useRoute', () => route)
  })
  afterEach(() => {
    wrappers.splice(0).forEach(w => w.unmount())
    vi.unstubAllGlobals()
  })

  async function setup() {
    const { useOpenPlanSessions } = await import('./usePlanThreads')
    let result!: ReturnType<typeof useOpenPlanSessions>
    wrappers.push(mount(defineComponent({ setup() {
      result = useOpenPlanSessions()
      return () => h('div')
    } }), { global: { plugins: [[VueQueryPlugin, { queryClient: client }]] } }))
    return result
  }

  it('keeps persisted order and prunes missing and closed sessions only after loading', async () => {
    const threads = await setup()
    expect(stored.value).toContain('missing')
    state.value.loaded = true
    await nextTick()
    expect(stored.value).toEqual(['a', 'b'])
    expect(threads.sessions.value.map(s => s.id)).toEqual(['a', 'b'])
  })

  it('shares the list, closes only the nav entry, and reopens on navigation', async () => {
    state.value.loaded = true
    route.params.sessionId = 'a'
    const first = await setup()
    const second = await setup()
    first.close(session('a'))
    expect(second.sessions.value.map(s => s.id)).not.toContain('a')
    expect(route.params.sessionId).toBe('a')
    expect(state.value.planSessions.some(s => s.id === 'a')).toBe(true)
    route.params.sessionId = 'closed'
    await nextTick()
    expect(first.sessions.value.map(s => s.id)).toContain('closed')
  })

  it('removes a closing session live, stays on its page, and reopens when a message reactivates it', async () => {
    state.value.loaded = true
    route.params.sessionId = 'a'
    const threads = await setup()
    state.value.planSessions = [session('a', true), session('b')]
    expect(threads.sessions.value.map(s => s.id)).not.toContain('a')
    expect(route.params.sessionId).toBe('a')
    state.value.planSessions = [session('a'), session('b')]
    expect(threads.sessions.value.map(s => s.id)).toContain('a')
  })

  it('keeps an explicitly reopened closed session through read acknowledgements', async () => {
    state.value.loaded = true
    route.params.sessionId = 'closed'
    const threads = await setup()
    state.value.loaded = true
    await nextTick()
    state.value.planSessions = state.value.planSessions.map(s => ({ ...s, unread: false }))
    expect(threads.sessions.value.map(s => s.id)).toContain('closed')
  })
})
