import { requireDatabase } from '@corral/db/testing'
import type { PlanSessionDetail, RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { Orchestrator } from './orchestrator.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

const { agents, runs, tasks } = schema

describe('two-phase update hold', () => {
  let t: TestApp
  let runner: FakeRunner
  beforeEach(async ({ skip }) => {
    requireDatabase('postgres', { skip })
    t = await createTestApp('postgres', { listen: true })
    runner = await FakeRunner.connect(t.server!.url)
  })
  afterEach(async () => {
    runner?.close()
    await t?.close()
  })

  const hold = () => t.request('POST', '/api/update-hold').then(r => r.json())
  async function row(id: string) {
    return (await t.db.select().from(runs).where(eq(runs.id, id)))[0]!
  }
  async function end(job: RunJob) {
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
    await vi.waitFor(async () => {
      expect((await row(job.runId)).state).toBe('completed')
      const session = await t.request('GET', `/api/plan/sessions/${job.planSessionId}`).then(r => r.json()) as PlanSessionDetail
      expect(session.activeRunId).toBeNull()
    })
  }
  async function startSession(projectId: string) {
    const res = await t.request('POST', '/api/plan/sessions', { projectId, text: 'Plan this feature' })
    expect(res.status).toBe(201)
    const created = await res.json() as PlanSessionDetail
    // Starts reply before queueing; observe the subsequent session update.
    let queued = created
    await expect.poll(async () => {
      queued = await t.request('GET', `/api/plan/sessions/${created.id}`).then(r => r.json()) as PlanSessionDetail
      return queued.activeRunId
    }).not.toBeNull()
    return queued
  }

  it.each(['developer', 'reviewer'] as const)('starts Plan turns and question replies while a %s drains; counts PM until it ends', async (role) => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    const [agent] = await t.db.select().from(agents).where(eq(agents.role, role))
    const [worker] = await t.db.insert(runs).values({ agentId: agent!.id, projectId: project.id, taskId: task.id, role, state: 'running', leaseEpoch: 1 }).returning()
    expect(await hold()).toEqual({ busy: 1 })
    const session = await startSession(project.id)
    const job = (await runner.next('run.assign', m => m.job.runId === session.activeRunId)).job
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'pm-session' })
    await vi.waitFor(async () => expect((await row(job.runId)).state).toBe('running'))
    expect(await hold()).toEqual({ busy: 2 })
    expect(await runner.call(job.runId, job.leaseEpoch, 'ask_question', { question: 'Which format?' })).toMatchObject({ ok: true })
    await end(job)
    // Question replies use the same message endpoint as Plan chat.
    expect((await t.request('POST', `/api/plan/sessions/${session.id}/messages`, { text: 'CSV please' })).status).toBe(201)
    const reply = (await runner.next('run.assign', m => m.job.planSessionId === session.id && m.job.runId !== job.runId)).job
    runner.send({ type: 'run.started', runId: reply.runId, leaseEpoch: reply.leaseEpoch, agentSessionId: 'pm-session' })
    await vi.waitFor(async () => expect((await row(reply.runId)).state).toBe('running'))
    await t.db.update(runs).set({ state: 'completed', endedAt: new Date() }).where(eq(runs.id, worker!.id))
    expect(await hold()).toEqual({ busy: 1 })
    expect(await hold()).toEqual({ busy: 1 })
    await end(reply)
    expect(await hold()).toEqual({ busy: 0 })
  })

  it.each(['release', 'restart'] as const)('saves finishing-phase messages and question replies with held jobs, then starts them on %s', async (resume) => {
    const project = await t.createProject()
    const question = await startSession(project.id)
    const first = (await runner.next('run.assign', m => m.job.runId === question.activeRunId)).job
    expect(await runner.call(first.runId, first.leaseEpoch, 'ask_question', { question: 'Which format?' })).toMatchObject({ ok: true })
    await end(first)
    expect(await hold()).toEqual({ busy: 0 })
    const fresh = await startSession(project.id)
    expect((await t.request('POST', `/api/plan/sessions/${question.id}/messages`, { text: 'CSV please' })).status).toBe(201)
    const answered = await t.request('GET', `/api/plan/sessions/${question.id}`).then(r => r.json()) as PlanSessionDetail
    expect(answered.messages.at(-1)).toMatchObject({ role: 'human', text: 'CSV please' })
    const ids = [fresh.activeRunId!, answered.activeRunId!]
    for (const id of ids) expect(await row(id)).toMatchObject({ state: 'queued', pmJob: expect.objectContaining({ role: 'pm' }) })
    await t.orchestrator.schedule()
    expect(await hold()).toEqual({ busy: 0 })
    expect(runner.received.filter(m => m.type === 'run.assign' && ids.includes(m.job.runId))).toHaveLength(0)
    expect(await t.request('GET', '/api/status').then(r => r.json())).toMatchObject({ stopped: false, updating: true })
    if (resume === 'release') {
      await t.request('DELETE', '/api/update-hold')
    } else {
      t.orchestrator.stop()
      // A fresh server orchestrator on the persisted DB has no in-memory hold.
      const restarted = new Orchestrator({ db: t.db, events: t.bus, runner: t.runner, github: t.github, blobs: t.blobs, transcripts: t.transcripts, publicUrl: 'http://corral.test' })
      restarted.plans = t.plans
      await restarted.init()
      expect(restarted.status).toEqual({ stopped: false, updating: false })
      await restarted.onConnected([], 'r1')
      await restarted.schedule()
      restarted.stop()
    }
    for (const id of ids) {
      await runner.next('run.assign', m => m.job.runId === id)
      expect((await row(id)).pmJob).toBeNull()
    }
  })

  it('keeps PM dispatch open while a merge is in flight, then queues without another hold poll', async () => {
    const project = await t.createProject()
    const merging = vi.spyOn(t.orchestrator.merges, 'inFlight', 'get').mockReturnValue(1)
    try {
      expect(await hold()).toEqual({ busy: 1 })
      const session = await startSession(project.id)
      const job = (await runner.next('run.assign', m => m.job.runId === session.activeRunId)).job
      await end(job)
      merging.mockReturnValue(0)
      const queued = await startSession(project.id)
      expect(await row(queued.activeRunId!)).toMatchObject({ state: 'queued', pmJob: expect.any(Object) })
      expect(await hold()).toEqual({ busy: 0 })
    } finally {
      merging.mockRestore()
    }
  })

  it('blocks developer, reviewer, design claims and merges in both phases', async () => {
    const project = await t.createProject()
    const active = await t.createTask(project.slug)
    const [agent] = await t.db.select().from(agents).where(eq(agents.role, 'developer'))
    const [worker] = await t.db.insert(runs).values({ agentId: agent!.id, projectId: project.id, taskId: active.id, role: 'developer', state: 'running' }).returning()
    // Hold before making tasks eligible, so the API's poke cannot claim them.
    await hold()
    for (const [type, status] of [['task', 'ready'], ['task', 'agent_review'], ['design', 'ready']] as const) {
      const task = await t.createTask(project.slug, { type })
      await t.db.update(tasks).set({ status, ...(status === 'agent_review' && { headSha: 'abc', prNumber: 41, prUrl: 'https://github.com/cormacrw/test-app/pull/41', branch: 'corral/review-me' }) }).where(eq(tasks.id, task.id))
    }
    const merge = await t.createTask(project.slug)
    await t.db.update(tasks).set({ status: 'ready_to_merge', prNumber: 42, prUrl: 'https://github.com/cormacrw/test-app/pull/42', headSha: 'abc' }).where(eq(tasks.id, merge.id))
    for (const phase of ['draining', 'finishing']) {
      if (phase === 'finishing') await t.db.update(runs).set({ state: 'completed', endedAt: new Date() }).where(eq(runs.id, worker!.id))
      await hold()
      await t.orchestrator.schedule()
      await t.orchestrator.merges.tick()
      expect(runner.received.filter(m => m.type === 'run.assign')).toHaveLength(0)
      expect(t.github.calls).toEqual([])
    }
  })
})
