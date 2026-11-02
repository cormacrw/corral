// @vitest-environment happy-dom
import { describe, expect, it, vi } from 'vitest'
import type { PlanSessionDetail } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { planMessages, plans, planSessions } from '~/prototype/fixtures'
import { applyEvent } from './dependencies'
import { keys } from './keys'
import { testQueryClient } from './mount-with-query'
import { markPlanRead, planSessionQuery } from './plan'

vi.mock('~/composables/useApi', () => ({ api: { plan: { session: vi.fn(), read: vi.fn() } } }))
const detail = (): PlanSessionDetail => structuredClone({ ...planSessions.find(s => s.id === 's-1')!, messages: planMessages['s-1']!, plans: plans['s-1']! })

describe('Plan session cache', () => {
  it('keeps live replies and plan revisions when an older snapshot finishes, without duplicating messages', async () => {
    const client = testQueryClient()
    const saved = detail()
    client.setQueryData(keys.plan.session(saved.id), saved)
    let resolve!: (session: PlanSessionDetail) => void
    vi.mocked(api.plan.session).mockImplementation(() => new Promise((r) => {
      resolve = r
    }))
    const fetching = client.fetchQuery(planSessionQuery(saved.id))
    const message = { ...saved.messages[0]!, id: 'new-reply', role: 'pm' as const, kind: 'message' as const, text: 'A streamed reply', recommendation: null, options: null }
    const plan = { ...saved.plans[0]!, status: 'approved' as const }
    applyEvent(client, { type: 'plan.message', message })
    applyEvent(client, { type: 'plan.message', message })
    applyEvent(client, { type: 'plan.updated', plan })
    resolve(saved)
    await fetching
    const cached = client.getQueryData<PlanSessionDetail>(keys.plan.session(saved.id))!
    expect(cached.messages.filter(m => m.id === message.id)).toHaveLength(1)
    expect(cached.plans.find(p => p.id === plan.id)?.status).toBe('approved')
  })

  it('does not mask newer snapshot fields when only a message arrived during the fetch', async () => {
    const client = testQueryClient()
    const saved = detail()
    client.setQueryData(keys.plan.session(saved.id), saved)
    let resolve!: (session: PlanSessionDetail) => void
    vi.mocked(api.plan.session).mockImplementation(() => new Promise((r) => {
      resolve = r
    }))
    const fetching = client.fetchQuery(planSessionQuery(saved.id))
    applyEvent(client, { type: 'plan.message', message: { ...saved.messages[0]!, id: 'reply' } })
    resolve({ ...saved, title: 'Newer server title', plans: saved.plans.map(p => ({ ...p, status: 'approved' })) })
    await fetching
    expect(client.getQueryData<PlanSessionDetail>(keys.plan.session(saved.id))).toMatchObject({ title: 'Newer server title', plans: [{ status: 'approved' }] })
  })

  it('acknowledges cached unread sessions in place without refetching or moving the session', async () => {
    const client = testQueryClient()
    const saved = detail()
    client.setQueryData(keys.plan.sessions(), [{ ...saved, id: 'newest' }, saved])
    client.setQueryData(keys.plan.session(saved.id), saved)
    vi.mocked(api.plan.read).mockResolvedValue({ ...saved, unread: false })
    const invalidate = vi.spyOn(client, 'invalidateQueries')
    markPlanRead(client, saved.id)
    applyEvent(client, { type: 'plan.session', session: { ...saved, unread: false } })
    expect(api.plan.read).toHaveBeenCalledWith(saved.id)
    expect(invalidate).not.toHaveBeenCalled()
    expect(client.getQueryData<PlanSessionDetail>(keys.plan.session(saved.id))?.unread).toBe(false)
    expect(client.getQueryData<PlanSessionDetail[]>(keys.plan.sessions())?.map(s => s.id)).toEqual(['newest', saved.id])
  })
})
