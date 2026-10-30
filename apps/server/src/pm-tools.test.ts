import { pmDirectTools, type RunEvent, type RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { transcriptExcerpt } from './pm-tools.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

const { agents, auditLog, epics, runs, tasks } = schema

const transcriptOf = (events: RunEvent[]) => new TextEncoder().encode(events.map(e => JSON.stringify(e)).join('\n') + '\n')

// Read through the runner protocol like a real PM turn
describe('list_runs and get_run', () => {
  let t: TestApp
  let runner: FakeRunner
  let pm: RunJob
  let reviewer: typeof agents.$inferSelect
  let developer: typeof agents.$inferSelect
  let failedReview: typeof runs.$inferSelect
  let taskReview: typeof runs.$inferSelect

  const call = (tool: 'list_runs' | 'get_run', input: unknown) => runner.call(pm.runId, pm.leaseEpoch, tool, input)
  const result = async (tool: 'list_runs' | 'get_run', input: unknown) => {
    const reply = await call(tool, input)
    if (!reply.ok) throw new Error(reply.error)
    return reply.result as Record<string, any> // eslint-disable-line @typescript-eslint/no-explicit-any
  }

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    await t.db.update(agents).set({ concurrency: 50 })
    runner = await FakeRunner.connect(t.server!.url)
    const all = await t.db.select().from(agents)
    reviewer = all.find(a => a.role === 'reviewer')!
    developer = all.find(a => a.role === 'developer')!
    const home = await t.createProject({ name: 'Planning project' })
    const res = await t.request('POST', '/api/plan/sessions', { projectId: home.id, text: 'Why did the review fail?' })
    expect(res.status).toBe(201)
    pm = (await runner.next('run.assign', m => m.job.role === 'pm')).job
    runner.send({ type: 'run.started', runId: pm.runId, leaseEpoch: pm.leaseEpoch, agentSessionId: 'sess' })
    await vi.waitFor(async () => expect((await t.db.select().from(runs).where(eq(runs.id, pm.runId)))[0]?.state).toBe('running'))

    // A failed epic review in another project: it has no task to search from
    const other = await t.createProject({ name: 'Another project' })
    const task = await t.createTask(other.slug)
    const [epic] = await t.db.insert(epics).values({ projectId: other.id, title: 'Saved searches', createdBy: t.actor }).returning()
    const ended = { state: 'failed' as const, startedAt: new Date(), endedAt: new Date() }
    const [review] = await t.db.insert(runs).values({ agentId: reviewer.id, projectId: other.id, epicId: epic!.id, role: 'reviewer', runnerName: 'home-server', error: 'spawn E2BIG', ...ended }).returning()
    const [onTask] = await t.db.insert(runs).values({ agentId: reviewer.id, projectId: other.id, taskId: task.id, role: 'reviewer', error: 'e'.repeat(5000), transcriptBlob: await t.blobs.put(transcriptOf([{ type: 'message', text: 'x'.repeat(500) }, { type: 'message', text: 'the end' }])), ...ended }).returning()
    await t.db.insert(runs).values({ agentId: developer.id, projectId: other.id, taskId: task.id, role: 'developer', ...ended })
    failedReview = review!
    taskReview = onTask!
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  it('retrieves a failed epic review by its displayed number, with no task reference', async () => {
    expect(await result('get_run', { runNumber: failedReview.number })).toMatchObject({
      id: failedReview.id,
      number: failedReview.number,
      taskRef: null,
      epicId: failedReview.epicId,
      epicTitle: 'Saved searches',
      agentName: reviewer.name,
      agentRuntime: 'claude-code',
      runnerName: 'home-server',
      role: 'reviewer',
      state: 'failed',
      outcome: null,
      error: 'spawn E2BIG',
      startedAt: failedReview.startedAt!.toISOString(),
      endedAt: failedReview.endedAt!.toISOString()
    })
  })

  it('still looks a run up by its id', async () => {
    expect(await result('get_run', { runId: failedReview.id })).toMatchObject({ number: failedReview.number })
  })

  it('says so when a run does not exist, and asks for exactly one identifier', async () => {
    expect(await call('get_run', { runNumber: 99_999_999 })).toMatchObject({ ok: false, error: 'Run #99999999 doesn\'t exist' })
    const id = '00000000-0000-4000-8000-000000000000'
    expect(await call('get_run', { runId: id })).toMatchObject({ ok: false, error: `Run ${id} doesn't exist` })
    expect(await call('get_run', {})).toMatchObject({ ok: false, error: 'Pass runNumber or runId, not both' })
    expect(await call('get_run', { runId: id, runNumber: 1 })).toMatchObject({ ok: false, error: 'Pass runNumber or runId, not both' })
  })

  it('says explicitly when the agent failed before producing a transcript', async () => {
    expect((await result('get_run', { runNumber: failedReview.number })).transcript).toEqual({
      excerpt: '',
      truncated: false,
      empty: true,
      note: 'This run has no transcript: the agent produced nothing before the run ended.'
    })
  })

  it('bounds the transcript to its end and says when it was cut', async () => {
    const short = await result('get_run', { runNumber: taskReview.number, transcriptLimit: 10 })
    expect(short.transcript).toMatchObject({ truncated: true, empty: false, excerpt: 'x\n\nthe end'.slice(-10), note: expect.stringContaining('last 10 of ') })
    expect(short.error).toHaveLength(2001)
    expect(short.note).toContain('cut to 2000')
    const whole = await result('get_run', { runNumber: taskReview.number, transcriptLimit: 20_000 })
    expect(whole.transcript).toMatchObject({ truncated: false, empty: false })
    expect(whole.transcript.excerpt).toHaveLength(509)
  })

  it('refuses a transcript limit over the maximum', async () => {
    expect(await call('get_run', { runNumber: taskReview.number, transcriptLimit: 20_001 })).toMatchObject({ ok: false })
  })

  it('lists failed reviewer runs across projects, epic reviews included', async () => {
    const { runs: listed } = await result('list_runs', { role: 'reviewer', status: 'failed' })
    expect(listed.map((r: { number: number }) => r.number)).toEqual([taskReview.number, failedReview.number])
    expect(listed[1]).toMatchObject({ epicTitle: 'Saved searches', taskRef: null, error: 'spawn E2BIG', agentRuntime: 'claude-code' })
  })

  it('caps the list, with a note when there is more', async () => {
    const capped = await result('list_runs', { role: 'reviewer', status: 'failed', limit: 1 })
    expect(capped.runs).toHaveLength(1)
    expect(capped.runs[0].error).toHaveLength(301)
    expect(capped.note).toContain('Showing the newest 1 matching runs')
  })

  it('filters by project and status, and lists active runs', async () => {
    const { runs: active } = await result('list_runs', { status: 'active' })
    expect(active.map((r: { id: string }) => r.id)).toEqual([pm.runId])
    const { runs: none } = await result('list_runs', { project: (await t.createProject()).slug })
    expect(none).toEqual([])
    expect(await call('list_runs', { taskRef: 'NOPE-1' })).toMatchObject({ ok: false, error: 'Task NOPE-1 doesn\'t exist' })
  })

  it('audits calls that worked and calls that failed, against the run\'s project', async () => {
    await result('get_run', { runNumber: failedReview.number })
    await call('get_run', { runNumber: 99_999_998 })
    const entries = await t.db.select().from(auditLog).where(eq(auditLog.action, 'pm.tool_called'))
    const read = entries.find(e => (e.detail as { summary: string }).summary === `Read run #${failedReview.number} on epic Saved searches`)
    expect(read).toMatchObject({ projectId: failedReview.projectId, actor: { kind: 'agent', role: 'pm', runId: pm.runId } })
    expect(entries.some(e => (e.detail as { ok: boolean, error?: string }).error === 'Run #99999998 doesn\'t exist')).toBe(true)
  })

  it('refuses these tools to developer, designer and reviewer runs', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug)
    const [{ runnerId }] = await t.db.select({ runnerId: runs.runnerId }).from(runs).where(eq(runs.id, pm.runId)) as [{ runnerId: string }]
    for (const role of ['developer', 'designer', 'reviewer'] as const) {
      const agent = (await t.db.select().from(agents)).find(a => a.role === role)!
      const [row] = await t.db.insert(runs).values({ agentId: agent.id, projectId: project.id, taskId: task.id, role, state: 'running', startedAt: new Date(), leaseEpoch: 7, runnerId, leaseExpiresAt: new Date(Date.now() + 60_000) }).returning()
      // The lease a claim gives it, so the role is what gets refused
      await t.db.update(tasks).set({ leaseRunId: row!.id, leaseRole: role, leaseEpoch: 7, leaseExpiresAt: new Date(Date.now() + 60_000) }).where(eq(tasks.id, task.id))
      for (const tool of ['list_runs', 'get_run', 'get_agent_activity'] as const) {
        expect(await runner.call(row!.id, 7, tool, {})).toMatchObject({ ok: false, error: `The ${role} can’t use ${tool}` })
      }
    }
  })
})

describe('transcriptExcerpt', () => {
  it('leaves out thinking and usage, and treats a transcript of only those as empty', () => {
    const silent: RunEvent[] = [{ type: 'thinking', text: 'hmm' }]
    expect(transcriptExcerpt(silent, 100, true)).toMatchObject({ excerpt: '', empty: true })
  })

  it('tells a live run with no output yet from one that ended without any', () => {
    expect(transcriptExcerpt([], 100, false).note).toBe('This run has no transcript yet.')
  })

  it('keeps the defaults within the schema\'s limits', () => {
    expect(z.object(pmDirectTools.get_run.input).parse({ runNumber: 1 }).transcriptLimit).toBe(4_000)
  })
})
