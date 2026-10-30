import type { PlanSessionDetail } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

// Exercise the HTTP routes over a listening server and the runner protocol.
const evidence: unknown[] = []
describe('idempotent, asynchronous Plan starts', () => {
  const driver = 'postgres'
  let t: TestApp
  let runner: FakeRunner
  let stream: ReadableStreamDefaultReader<string>
  let sse = ''
  let collecting: Promise<void>
  beforeAll(async () => {
    t = await createTestApp(driver, { listen: true })
    runner = await FakeRunner.connect(t.server!.url)
    await t.request('GET', '/api/setup/clis')
    const response = await fetch(`${t.server!.url}/api/events`)
    stream = response.body!.pipeThrough(new TextDecoderStream()).getReader()
    collecting = (async () => {
      while (true) {
        const { done, value } = await stream.read()
        if (done) break
        sse += value
      }
    })()
    await vi.waitFor(() => expect(sse).toContain('event: ready'))
  })
  afterAll(async () => {
    await stream?.cancel()
    await collecting
    evidence.push({ driver, sse })
    if (process.env.CORRAL_PLAN_EVIDENCE) await writeFile(process.env.CORRAL_PLAN_EVIDENCE, JSON.stringify(evidence, null, 2))
    runner?.close()
    await t?.close()
  })
  async function request(method: string, path: string, body?: unknown) {
    const response = await fetch(`${t.server!.url}/api${path}`, {
      method,
      ...(body !== undefined && { body: JSON.stringify(body), headers: { 'content-type': 'application/json' } })
    })
    const result = await response.json()
    evidence.push({ method, path, body, status: response.status, response: result })
    return { status: response.status, body: result as PlanSessionDetail }
  }

  it('stores the chosen id once, replies during a blocked queue, and publishes the later run and reply', async () => {
    const project = await t.createProject({ repository: 'cormacrw/test-app' })
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
    const id = randomUUID()
    const input = { id, projectId: project.id, text: 'Plan a small change', runtime: 'codex' }
    let release!: () => void
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const start = t.orchestrator.startPmRun.bind(t.orchestrator)
    const spy = vi.spyOn(t.orchestrator, 'startPmRun').mockImplementation(async (...args) => {
      await gate
      return start(...args)
    })
    const detectionCount = () => runner.received.filter(m => m.type === 'job.request' && m.job.kind === 'detect_clis').length
    const before = detectionCount()
    try {
      const [created, concurrent] = await Promise.all([request('POST', '/plan/sessions', input), request('POST', '/plan/sessions', input)])
      expect(concurrent.body.id).toBe(id)
      expect(created.status).toBe(201)
      expect(created.body).toMatchObject({ id, activeRunId: null, messages: [{ role: 'human', text: input.text }] })
      expect((await request('GET', `/plan/sessions/${id}`)).body.messages).toHaveLength(1)
      // Concurrent retries also leave the original message and turn untouched.
      const retries = await Promise.all([request('POST', '/plan/sessions', input), request('POST', '/plan/sessions', input)])
      expect(retries.map(r => r.body.id)).toEqual([id, id])
      expect(await t.db.select().from(schema.planMessages).where(eq(schema.planMessages.sessionId, id))).toHaveLength(1)
      expect(await t.db.select().from(schema.planSessions).where(eq(schema.planSessions.id, id))).toHaveLength(1)
      expect(await t.db.select().from(schema.runs).where(eq(schema.runs.planSessionId, id))).toHaveLength(0)
      expect(detectionCount()).toBe(before)
      evidence.push({ beforeDetectionRequests: before, afterDetectionRequests: detectionCount(), queueBlocked: true, sessions: 1, humanMessages: 1, pmRuns: 0 })
      await request('GET', '/plan/sessions')
      const other = await t.createProject()
      expect((await request('POST', '/plan/sessions', { ...input, projectId: other.id })).status).toBe(409)
      release()
      const { job } = await runner.next('run.assign', m => m.job.planSessionId === id)
      await expect.poll(() => t.events.some(e => e.type === 'plan.session' && e.session.id === id && e.session.activeRunId === job.runId)).toBe(true)
      expect(spy).toHaveBeenCalledTimes(1)
      runner.send({ type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [{ type: 'message', text: 'Ready to discuss the change' }] })
      runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
      await expect.poll(() => t.events.some(e => e.type === 'plan.message' && e.message.sessionId === id && e.message.text === 'Ready to discuss the change')).toBe(true)
      await expect.poll(() => sse.includes('Ready to discuss the change')).toBe(true)
      evidence.push({ queuedJob: job, liveEvents: t.events.filter(e => (e.type === 'plan.session' && e.session.id === id) || (e.type === 'plan.message' && e.message.sessionId === id)) })
      await request('GET', `/plan/sessions/${id}`)
      expect((await request('POST', '/plan/sessions', input)).body.id).toBe(id)
      expect(await t.db.select().from(schema.runs).where(eq(schema.runs.planSessionId, id))).toHaveLength(1)
      expect((await request('GET', `/plan/sessions/${id}`)).body.messages).toHaveLength(2)
    } finally {
      release()
      spy.mockRestore()
    }
  })

  it('publishes a durable error when queueing fails', async () => {
    const project = await t.createProject()
    const spy = vi.spyOn(t.orchestrator, 'startPmRun').mockRejectedValueOnce(new Error('Queue unavailable'))
    try {
      const id = randomUUID()
      expect((await request('POST', '/plan/sessions', { id, projectId: project.id, text: 'Try a turn' })).status).toBe(201)
      await expect.poll(() => t.events.some(e => e.type === 'plan.message' && e.message.sessionId === id && e.message.kind === 'error')).toBe(true)
      await expect.poll(() => sse.includes('Could not queue the PM turn: Queue unavailable')).toBe(true)
      const session = await request('GET', `/plan/sessions/${id}`)
      expect(session.body.messages.at(-1)).toMatchObject({ kind: 'error', text: 'Could not queue the PM turn: Queue unavailable' })
      evidence.push({ liveEvents: t.events.filter(e => e.type === 'plan.message' && e.message.sessionId === id) })
    } finally {
      spy.mockRestore()
    }
  })

  it('refreshes cached CLI availability and keeps the runtime validation message', async () => {
    const project = await t.createProject()
    const answer = runner.onJob
    runner.onJob = job => job.kind === 'detect_clis' ? { kind: 'detect_clis', clis: [{ id: 'codex', version: null, signedIn: false }] } : answer(job)
    try {
      await request('GET', '/setup/clis')
      const result = await request('POST', '/plan/sessions', { id: randomUUID(), projectId: project.id, runtime: 'codex', text: 'Hello' })
      expect(result.status).toBe(400)
      expect(JSON.stringify(result.body)).toContain('Codex CLI isn’t installed on the runner, so the codex runtime can’t be used')
      expect(await t.db.select().from(schema.planSessions).where(eq(schema.planSessions.projectId, project.id))).toHaveLength(0)
    } finally {
      runner.onJob = answer
      await request('GET', '/setup/clis')
    }
  })

  it('rejects offline before storing a session even with cached CLIs', async () => {
    const project = await t.createProject()
    runner.close()
    await expect.poll(() => t.runner.online).toBe(false)
    const id = randomUUID()
    const result = await request('POST', '/plan/sessions', { id, projectId: project.id, text: 'Offline' })
    expect(result.status).toBe(503)
    expect(result.body).toEqual({ error: { code: 'runner_offline' } })
    expect(await t.db.select().from(schema.planSessions).where(eq(schema.planSessions.id, id))).toHaveLength(0)
    evidence.push({ offlineSessionId: id, storedSessions: 0 })
  })
})
