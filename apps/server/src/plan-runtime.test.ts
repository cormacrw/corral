import type { PlanSession, PlanSessionDetail, RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'

const { agents, auditLog, planSessions } = schema

// Each Plan session picks the PM's runtime, locked once it has messages (D18)
describe('plan session runtime', () => {
  let t: TestApp
  let runner: FakeRunner

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    await t.db.update(agents).set({ concurrency: 50 }).where(eq(agents.role, 'pm'))
    runner = await FakeRunner.connect(t.server!.url)
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  const pmJob = async (sessionId: string): Promise<RunJob> => (await runner.next('run.assign', m => m.job.planSessionId === sessionId)).job

  async function endTurn(job: RunJob, agentSessionId: string, reply: string) {
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId })
    await sleep(50)
    runner.send({ type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [{ type: 'message', text: reply }] })
    await sleep(50)
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
    await expect.poll(async () => (await t.request('GET', `/api/plan/sessions/${job.planSessionId}`).then(r => r.json()) as PlanSession).activeRunId).toBeNull()
  }

  it('reads a session created without a runtime as claude-code', async () => {
    const project = await t.createProject()
    const [row] = await t.db.insert(planSessions).values({ projectId: project.id, title: 'Old', createdBy: { type: 'system' } }).returning()
    expect(row!.runtime).toBe('claude-code')
    expect(await t.request('GET', `/api/plan/sessions/${row!.id}`).then(r => r.json())).toMatchObject({ runtime: 'claude-code' })
  })

  it('runs a Claude session on claude-code by default, resuming its session', async () => {
    const project = await t.createProject()
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan it' }).then(r => r.json()) as PlanSessionDetail
    expect(created.runtime).toBe('claude-code')
    const first = await pmJob(created.id)
    expect(first).toMatchObject({ runtime: 'claude-code', agentSessionId: null })
    await endTurn(first, 'claude-sess', 'Sure')
    await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'More' })
    expect(await pmJob(created.id)).toMatchObject({ runtime: 'claude-code', agentSessionId: 'claude-sess' })
  })

  it('runs every turn of a Codex session on codex, resuming the same Codex session, whatever the PM agent\'s runtime', async () => {
    const project = await t.createProject()
    const res = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Plan a login feature', runtime: 'codex' })
    expect(res.status).toBe(201)
    const created = await res.json() as PlanSessionDetail
    expect(created.runtime).toBe('codex')

    const first = await pmJob(created.id)
    expect(first).toMatchObject({ role: 'pm', runtime: 'codex', agentSessionId: null })
    // The PM's tools work the same on either runtime
    expect(await runner.call(first.runId, first.leaseEpoch, 'list_tasks', {})).toMatchObject({ ok: true, result: { tasks: [] } })
    const proposed = await runner.call(first.runId, first.leaseEpoch, 'propose_plan', {
      title: 'Login', tasks: [{ key: 't1', title: 'Form', description: 'Build it', type: 'frontend', acceptanceCriteria: ['It works'] }]
    })
    expect(proposed).toMatchObject({ ok: true })
    await endTurn(first, 'codex-thread-1', 'Proposed a plan')

    await t.request('POST', `/api/plan/sessions/${created.id}/messages`, { text: 'Looks close' })
    expect(await pmJob(created.id)).toMatchObject({ runtime: 'codex', agentSessionId: 'codex-thread-1' })
    const [pm] = await t.db.select().from(agents).where(eq(agents.role, 'pm'))
    expect(pm!.runtime).toBe('claude-code')
  })

  it('locks the runtime once the session has messages', async () => {
    const project = await t.createProject()
    const created = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Hello' }).then(r => r.json()) as PlanSessionDetail
    await endTurn(await pmJob(created.id), 'claude-locked', 'Hi')
    const res = await t.request('PATCH', `/api/plan/sessions/${created.id}`, { runtime: 'codex' })
    expect(res.status).toBe(409)
    expect(await res.json()).toMatchObject({ error: { code: 'conflict', constraint: 'plan_session_runtime_locked' } })
    expect(await t.request('GET', `/api/plan/sessions/${created.id}`).then(r => r.json())).toMatchObject({ runtime: 'claude-code' })
    // Asking for the runtime it already has changes nothing
    expect((await t.request('PATCH', `/api/plan/sessions/${created.id}`, { runtime: 'claude-code' })).status).toBe(200)
  })

  it('changes the runtime of a session with no messages yet, and audits it', async () => {
    const project = await t.createProject()
    const [row] = await t.db.insert(planSessions).values({ projectId: project.id, title: 'Empty', createdBy: { type: 'system' } }).returning()
    const res = await t.request('PATCH', `/api/plan/sessions/${row!.id}`, { runtime: 'codex' })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ runtime: 'codex' })
    const [audit] = await t.db.select().from(auditLog).where(and(eq(auditLog.projectId, project.id), eq(auditLog.action, 'plan.runtime')))
    expect(audit?.detail).toMatchObject({ sessionId: row!.id, from: 'claude-code', to: 'codex' })
  })

  it('refuses an unknown runtime, or one whose CLI the runner doesn\'t have', async () => {
    const project = await t.createProject()
    expect((await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Hi', runtime: 'gemini' })).status).toBe(400)
    const onJob = runner.onJob
    runner.onJob = job => job.kind === 'detect_clis' ? { kind: 'detect_clis', clis: [{ id: 'claude', version: '2.0.0', signedIn: true }, { id: 'codex', version: null, signedIn: false }] } : onJob(job)
    try {
      const res = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Hi', runtime: 'codex' })
      expect(res.status).toBe(400)
      expect(JSON.stringify(await res.json())).toContain('Codex CLI isn’t installed')
    } finally {
      runner.onJob = onJob
    }
    expect(await t.db.select().from(planSessions).where(eq(planSessions.projectId, project.id))).toEqual([])
  })
})
