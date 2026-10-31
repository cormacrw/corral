// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { ref } from 'vue'
import type { PlanSessionDetail } from '@corral/contracts'
import { api } from './useApi'
import { testQueryClient } from '~/queries/mount-with-query'
import { keys } from '~/queries/keys'
import { connectPendingPlanCache, usePendingPlan } from './usePendingPlan'

vi.mock('./useApi', () => ({ api: { plan: { start: vi.fn() } } }))
let client = testQueryClient()
beforeEach(() => {
  client = testQueryClient()
  connectPendingPlanCache(client)
  vi.resetAllMocks()
  const state = new Map()
  vi.stubGlobal('useState', (key: string, init: () => unknown) => {
    if (!state.has(key)) state.set(key, ref(init()))
    return state.get(key)
  })
})
const real = (s: PlanSessionDetail): PlanSessionDetail => ({ ...s, messages: s.messages.map(m => ({ ...m, id: 'server-human' })) })

describe('optimistic Plan starts', () => {
  it('shares the seeded message and context across routes before any request finishes', async () => {
    const pending = usePendingPlan()
    const id = pending.seed('project', 'Build this\n\n![design](attachment:image)', 'codex', 'TA-1')
    const second = usePendingPlan()
    expect(second.entries.value[id]?.session.messages[0]?.text).toContain('![design]')
    expect(client.getQueryData<PlanSessionDetail>(keys.plan.session(id))?.messages[0]?.text).toContain('![design]')
    expect(second.entries.value[id]?.taskRef).toBe('TA-1')
    let resolve!: (value: PlanSessionDetail) => void
    vi.mocked(api.plan.start).mockImplementation(() => new Promise((r) => {
      resolve = r
    }))
    const request = pending.start(id)
    expect(second.entries.value[id]?.state).toBe('starting')
    resolve(real(second.entries.value[id]!.session))
    await request
    expect(second.entries.value[id]?.session.messages.map(m => m.id)).toEqual(['server-human'])
    expect(client.getQueryData<PlanSessionDetail>(keys.plan.session(id))?.messages.map(m => m.id)).toEqual(['server-human'])
    expect(api.plan.start).toHaveBeenCalledWith('project', expect.any(String), 'TA-1', 'codex', id)
  })

  it('keeps a failed message and retries with the same UUID', async () => {
    const pending = usePendingPlan()
    const id = pending.seed('project', 'Keep my text', 'codex')
    vi.mocked(api.plan.start).mockRejectedValueOnce(new Error('Network unavailable'))
    await pending.start(id)
    expect(pending.entries.value[id]).toMatchObject({ state: 'failed', error: 'Network unavailable', message: 'Keep my text' })
    vi.mocked(api.plan.start).mockResolvedValue(real(pending.entries.value[id]!.session))
    await pending.start(id)
    expect(vi.mocked(api.plan.start).mock.calls.map(c => c[4])).toEqual([id, id])
    expect(pending.entries.value[id]?.state).toBe('accepted')
    expect(pending.entries.value[id]?.session.messages).toHaveLength(1)
  })

  it('deduplicates live messages and preserves events that beat the POST response', async () => {
    const pending = usePendingPlan()
    const id = pending.seed('project', 'Hello', 'codex')
    const response = real(pending.entries.value[id]!.session)
    let resolve!: (value: PlanSessionDetail) => void
    vi.mocked(api.plan.start).mockImplementation(() => new Promise((r) => {
      resolve = r
    }))
    const request = pending.start(id)
    pending.apply({ type: 'plan.message', message: response.messages[0]! })
    pending.apply({ type: 'plan.message', message: response.messages[0]! })
    pending.apply({ type: 'plan.session', session: { ...response, activeRunId: 'run' } })
    pending.apply({ type: 'plan.message', message: { ...response.messages[0]!, id: 'reply', role: 'pm', text: 'Working on it' } })
    resolve(response)
    await request
    expect(pending.entries.value[id]?.session.messages.map(m => m.id)).toEqual(['server-human', 'reply'])
    expect(pending.entries.value[id]?.session.activeRunId).toBe('run')
  })

  it('uses response metadata when only the human event arrived first', async () => {
    const pending = usePendingPlan()
    const id = pending.seed('project', 'Hello', 'codex')
    const response = { ...real(pending.entries.value[id]!.session), activeRunId: 'server-run' }
    vi.mocked(api.plan.start).mockImplementation(async () => {
      pending.apply({ type: 'plan.message', message: response.messages[0]! })
      return response
    })
    await pending.start(id)
    expect(pending.entries.value[id]?.session.activeRunId).toBe('server-run')
    expect(pending.entries.value[id]?.session.messages).toHaveLength(1)
  })

  it('does not show a failed start when live events proved acceptance', async () => {
    const pending = usePendingPlan()
    const id = pending.seed('project', 'Hello', 'codex')
    vi.mocked(api.plan.start).mockImplementation(async () => {
      pending.apply({ type: 'plan.session', session: pending.entries.value[id]!.session })
      throw new Error('Lost response')
    })
    await pending.start(id)
    expect(pending.entries.value[id]?.state).toBe('accepted')
  })
})
