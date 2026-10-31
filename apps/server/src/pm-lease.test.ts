import { LEASE_DURATION_MS } from '@corral/core'
import type { PlanSessionDetail, RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

const { planMessages, planSessions, runs } = schema

// A PM turn the server has to end itself: its run.ended will never count, so
// the session hears from here, and an orphan can't hold anything up
describe('PM turns the runner lost', () => {
  let t: TestApp
  let runner: FakeRunner

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    runner = await FakeRunner.connect(t.server!.url)
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  async function turn(): Promise<RunJob> {
    const project = await t.createProject()
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan it' }).then(r => r.json()) as PlanSessionDetail
    return (await runner.next('run.assign', m => m.job.planSessionId === created.id)).job
  }

  const run = async (id: string) => (await t.db.select().from(runs).where(eq(runs.id, id)))[0]!
  const errors = (job: RunJob) => t.db.select().from(planMessages).where(and(eq(planMessages.sessionId, job.planSessionId!), eq(planMessages.kind, 'error')))
  const unread = async (job: RunJob) => (await t.db.select().from(planSessions).where(eq(planSessions.id, job.planSessionId!)))[0]!.unread
  const later = (ms: number) => {
    t.clock.now = new Date(t.clock.now.getTime() + ms)
  }

  it('expires a turn whose runner went quiet, so the session and the update hold are free again', async () => {
    const job = await turn()
    expect((await run(job.runId)).leaseExpiresAt).toEqual(new Date(t.clock.now.getTime() + LEASE_DURATION_MS))
    later(LEASE_DURATION_MS + 1000)
    await t.orchestrator.sweepLeases()
    expect(await run(job.runId)).toMatchObject({ state: 'interrupted', error: expect.stringContaining('lease expired') })
    expect((await runner.next('run.stop', m => m.runId === job.runId)).reason).toBe('Lease expired')
    expect((await errors(job)).map(m => m.text)).toEqual([expect.stringContaining('lease expired')])
    expect(await unread(job)).toBe(true)
    expect((await t.request('POST', `/api/plan/sessions/${job.planSessionId}/messages`, { text: 'Again' })).status).toBe(201)
    await t.orchestrator.holdForUpdate()
    t.orchestrator.releaseUpdate()
  })

  it('keeps a turn the runner still lists in its heartbeats', async () => {
    const job = await turn()
    later(LEASE_DURATION_MS - 1000)
    await t.orchestrator.onHeartbeat([{ runId: job.runId, leaseEpoch: job.leaseEpoch }], 'r1')
    later(2000)
    await t.orchestrator.sweepLeases()
    expect((await run(job.runId)).state).toBe('queued')
  })

  it('expires an orphan left from before PM turns had a lease', async () => {
    const job = await turn()
    await t.db.update(runs).set({ leaseExpiresAt: null, state: 'running' }).where(eq(runs.id, job.runId))
    later(LEASE_DURATION_MS - 1000)
    await t.orchestrator.sweepLeases()
    expect((await run(job.runId)).state).toBe('running')
    later(2000)
    await t.orchestrator.sweepLeases()
    expect((await run(job.runId)).state).toBe('interrupted')
  })

  it('tells the session when the kill switch ends its turn, and keeps what it had said', async () => {
    const job = await turn()
    await t.transcripts.append(job.runId, [{ type: 'message', text: 'Half an answer' }])
    await t.orchestrator.stopAll(t.actor)
    const said = await t.db.select().from(planMessages).where(and(eq(planMessages.runId, job.runId)))
    expect(said).toMatchObject([{ kind: 'message', text: 'Half an answer' }])
    expect(await unread(job)).toBe(true)
    await t.orchestrator.resumeAll(t.actor)
  })

  it('tells the session when a reconnecting runner no longer has its turn', async () => {
    const job = await turn()
    await t.orchestrator.onConnected([], 'r1')
    expect(await run(job.runId)).toMatchObject({ state: 'interrupted' })
    expect((await errors(job)).map(m => m.text)).toEqual([expect.stringContaining('The runner restarted')])
    expect(await unread(job)).toBe(true)
  })

  it('ends a turn that could not be sent and still sends the ones behind it', async () => {
    const held = [await t.createProject(), await t.createProject()]
    const live = t.runner.send.bind(t.runner)
    let failed = false
    const spy = vi.spyOn(t.runner, 'send').mockImplementation((message, id) => {
      if (message.type === 'run.assign' && !failed) {
        failed = true
        throw new Error('Socket write failed')
      }
      return live(message, id)
    })
    const sessions: PlanSessionDetail[] = []
    for (const project of held) sessions.push(await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan it' }).then(r => r.json()) as PlanSessionDetail)
    const assigned = await runner.next('run.assign', m => m.job.planSessionId === sessions[1]!.id || m.job.planSessionId === sessions[0]!.id)
    spy.mockRestore()
    const lost = sessions.find(s => s.id !== assigned.job.planSessionId)!
    await vi.waitFor(async () => {
      const [ended] = await t.db.select().from(runs).where(eq(runs.planSessionId, lost.id))
      expect(ended).toMatchObject({ state: 'interrupted', error: expect.stringContaining('Socket write failed') })
    })
  })
})
