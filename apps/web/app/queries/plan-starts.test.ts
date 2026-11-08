// @vitest-environment happy-dom
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { defineComponent, h } from 'vue'
import type { PlanSessionDetail } from '@corral/contracts'
import { api } from '~/queries/api'
import { applyEvent, type PlanStarts } from '~/queries/dependencies'
import { mountWithQuery, testQueryClient } from '~/queries/mount-with-query'
import { keys } from '~/queries/keys'
import { usePlanStarts } from '~/queries/plan'

vi.mock('~/queries/api', () => ({ api: { plan: { start: vi.fn() } } }))
let client = testQueryClient()
beforeEach(() => {
  client = testQueryClient()
  vi.resetAllMocks()
})
// Each call mounts its own component, as two pages would
function usePending() {
  let starts!: ReturnType<typeof usePlanStarts>
  mountWithQuery(defineComponent({ setup() {
    starts = usePlanStarts()
    return () => h('div')
  } }), { client })
  return starts
}
const entries = () => client.getQueryData<PlanStarts>(keys.plan.starts()) ?? {}
const real = (s: PlanSessionDetail): PlanSessionDetail => ({ ...s, messages: s.messages.map(m => ({ ...m, id: 'server-human' })) })

describe('optimistic Plan starts', () => {
  it('shares the seeded message and context across routes before any request finishes', async () => {
    const pending = usePending()
    const id = pending.seed('project', 'Build this\n\n![design](attachment:image)', 'codex', 'TA-1')
    const second = usePending()
    expect(entries()[id]?.session.messages[0]?.text).toContain('![design]')
    expect(client.getQueryData<PlanSessionDetail>(keys.plan.session(id))?.messages[0]?.text).toContain('![design]')
    expect(entries()[id]?.taskRef).toBe('TA-1')
    let resolve!: (value: PlanSessionDetail) => void
    vi.mocked(api.plan.start).mockImplementation(() => new Promise((r) => {
      resolve = r
    }))
    const request = second.start(id)
    expect(entries()[id]?.state).toBe('starting')
    resolve(real(entries()[id]!.session))
    await request
    expect(entries()[id]?.session.messages.map(m => m.id)).toEqual(['server-human'])
    expect(client.getQueryData<PlanSessionDetail>(keys.plan.session(id))?.messages.map(m => m.id)).toEqual(['server-human'])
    expect(api.plan.start).toHaveBeenCalledWith('project', expect.any(String), 'TA-1', 'codex', id)
  })

  it('keeps a failed message and retries with the same UUID', async () => {
    const pending = usePending()
    const id = pending.seed('project', 'Keep my text', 'codex')
    vi.mocked(api.plan.start).mockRejectedValueOnce(new Error('Network unavailable'))
    await pending.start(id)
    expect(entries()[id]).toMatchObject({ state: 'failed', error: 'Network unavailable', message: 'Keep my text' })
    vi.mocked(api.plan.start).mockResolvedValue(real(entries()[id]!.session))
    await pending.start(id)
    expect(vi.mocked(api.plan.start).mock.calls.map(c => c[4])).toEqual([id, id])
    expect(entries()[id]?.state).toBe('accepted')
    expect(entries()[id]?.session.messages).toHaveLength(1)
  })

  it('deduplicates live messages and preserves events that beat the POST response', async () => {
    const pending = usePending()
    const id = pending.seed('project', 'Hello', 'codex')
    const response = real(entries()[id]!.session)
    let resolve!: (value: PlanSessionDetail) => void
    vi.mocked(api.plan.start).mockImplementation(() => new Promise((r) => {
      resolve = r
    }))
    const request = pending.start(id)
    applyEvent(client, { type: 'plan.message', message: response.messages[0]! })
    applyEvent(client, { type: 'plan.message', message: response.messages[0]! })
    applyEvent(client, { type: 'plan.session', session: { ...response, activeRunId: 'run' } })
    applyEvent(client, { type: 'plan.message', message: { ...response.messages[0]!, id: 'reply', role: 'pm', kind: 'message', text: 'Working on it', recommendation: null, options: null } })
    resolve(response)
    await request
    expect(entries()[id]?.session.messages.map(m => m.id)).toEqual(['server-human', 'reply'])
    expect(entries()[id]?.session.activeRunId).toBe('run')
  })

  it('uses response metadata when only the human event arrived first', async () => {
    const pending = usePending()
    const id = pending.seed('project', 'Hello', 'codex')
    const response = { ...real(entries()[id]!.session), activeRunId: 'server-run' }
    vi.mocked(api.plan.start).mockImplementation(async () => {
      applyEvent(client, { type: 'plan.message', message: response.messages[0]! })
      return response
    })
    await pending.start(id)
    expect(entries()[id]?.session.activeRunId).toBe('server-run')
    expect(entries()[id]?.session.messages).toHaveLength(1)
  })

  it('does not show a failed start when live events proved acceptance', async () => {
    const pending = usePending()
    const id = pending.seed('project', 'Hello', 'codex')
    vi.mocked(api.plan.start).mockImplementation(async () => {
      applyEvent(client, { type: 'plan.session', session: entries()[id]!.session })
      throw new Error('Lost response')
    })
    await pending.start(id)
    expect(entries()[id]?.state).toBe('accepted')
  })
})
