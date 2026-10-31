import { databaseFixture } from '@corral/db/testing'
import type { Inbox, Project, Run, RunJob, RunTimings, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { and, asc, eq, ne } from 'drizzle-orm'
import { afterAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'

const { agents, auditLog, comments, runs, tasks } = schema

// Concurrency and leases: Postgres only (D14)
describe('orchestrator', () => {
  let t: TestApp
  let runner: FakeRunner

  databaseFixture('postgres', async () => {
    t = await createTestApp('postgres', { listen: true })
    // Each test leaves its run live, so the developer and runner need room for all of them
    await t.db.update(agents).set({ concurrency: 50 }).where(ne(agents.role, 'pm'))
    runner = await FakeRunner.connect(t.server!.url, [], 'r1', { slots: 50 })
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  async function approvedTask(input: Parameters<TestApp['createTask']>[1] = {}): Promise<{ project: Project, task: Task }> {
    const project = await t.createProject()
    const task = await t.createTask(project.slug, input)
    const res = await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
    expect(res.status).toBe(200)
    return { project, task }
  }

  async function taskRow(id: string) {
    const [row] = await t.db.select().from(tasks).where(eq(tasks.id, id))
    return row!
  }

  async function runRow(id: string) {
    const [row] = await t.db.select().from(runs).where(eq(runs.id, id))
    return row!
  }

  // Approve, let the scheduler claim, and take the assignment off the wire
  async function assigned(input: Parameters<TestApp['createTask']>[1] = {}) {
    const { project, task } = await approvedTask(input)
    await t.orchestrator.schedule()
    const assign = await runner.next('run.assign', m => m.job.taskId === task.id)
    return { project, task, job: assign.job }
  }

  async function pause(project: Project) {
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  }

  it('names the claiming agent’s runtime in the job (D15)', async () => {
    await t.db.update(agents).set({ runtime: 'codex' }).where(eq(agents.role, 'developer'))
    try {
      const { project, job } = await assigned()
      expect(job.runtime).toBe('codex')
      await pause(project)
    } finally {
      await t.db.update(agents).set({ runtime: 'claude-code' }).where(eq(agents.role, 'developer'))
    }
  })

  it('claims an approved task and assigns a developer job', async () => {
    const { project, task, job } = await assigned()
    expect(job).toMatchObject({ role: 'developer', runtime: 'claude-code', taskId: task.id, taskRef: task.ref, leaseEpoch: 1, repository: project.repository })
    expect(job.branch).toMatch(new RegExp(`^corral/${task.ref.toLowerCase()}-`))
    expect(job.prompt).toContain('Shows an error on a bad password')
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress', leaseRunId: job.runId, leaseEpoch: 1 })
    await pause(project)
  })

  it('lets the developer read an attachment from its own project, but not another project\'s', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    const upload = (slug: string) => t.request('POST', `/api/projects/${slug}/attachments`, new Blob([png], { type: 'image/png' })).then(r => r.json()) as Promise<{ id: string }>
    const { project, job } = await assigned()
    const own = await upload(project.slug)
    const foreign = await upload((await t.createProject()).slug)
    expect(await runner.call(job.runId, job.leaseEpoch, 'get_attachment', { attachmentId: own.id }))
      .toMatchObject({ ok: true, result: { id: own.id, fileName: 'image.png', mimeType: 'image/png', images: [{ mimeType: 'image/png', dataBase64: png.toString('base64') }] } })
    expect(await runner.call(job.runId, job.leaseEpoch, 'get_attachment', { attachmentId: foreign.id }))
      .toMatchObject({ ok: false, error: `${foreign.id} isn't an attachment in this project` })
    await pause(project)
  })

  it('lists the task\'s images in the developer prompt and get_task', async () => {
    const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64')
    const project = await t.createProject()
    const upload = (slug: string, name: string) => t.request('POST', `/api/projects/${slug}/attachments?name=${name}`, new Blob([png], { type: 'image/png' })).then(r => r.json()) as Promise<{ id: string }>
    const mockup = await upload(project.slug, 'mockup.png')
    const bug = await upload(project.slug, 'bug.png')
    const foreign = await upload((await t.createProject()).slug, 'other.png')
    await pause(project)
    const task = await t.createTask(project.slug, {
      description: { type: 'doc', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Like this' }] }, { type: 'image', attrs: { src: `attachment:${mockup.id}` } }, { type: 'image', attrs: { src: `attachment:${foreign.id}` } }] }
    })
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/comments`, { body: `Also ![bug](attachment:${bug.id}) and ![again](attachment:${mockup.id})` })).status).toBe(201)
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })).status).toBe(200)
    await t.db.update(schema.projects).set({ paused: false }).where(eq(schema.projects.id, project.id))
    await t.orchestrator.schedule()
    const { job } = await runner.next('run.assign', m => m.job.taskId === task.id)

    expect(job.prompt).toContain('## Attached images')
    expect(job.prompt).toContain(`- ${mockup.id}: "mockup.png" in the description, a comment by`)
    expect(job.prompt).toMatch(new RegExp(`- ${bug.id}: "bug.png" in a comment by \\S+`))
    // The description keeps the human's raw attachment reference, but only
    // this project's images may be advertised as available to the agent.
    expect(job.prompt).not.toContain(`- ${foreign.id}:`)
    const read = await runner.call(job.runId, job.leaseEpoch, 'get_task', {})
    expect(read).toMatchObject({
      ok: true,
      result: {
        attachments: [
          { id: mockup.id, fileName: 'mockup.png', foundIn: ['the description', expect.stringMatching(/^a comment by /)] },
          { id: bug.id, fileName: 'bug.png', foundIn: [expect.stringMatching(/^a comment by /)] }
        ]
      }
    })
    await pause(project)
  })

  it('renews the lease from heartbeats and marks the run running on run.started', async () => {
    const { project, task, job } = await assigned()
    const before = (await taskRow(task.id)).leaseExpiresAt!
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'sess-1' })
    t.clock.now = new Date(t.clock.now.getTime() + 60_000)
    runner.send({ type: 'heartbeat', activeRuns: [{ runId: job.runId, leaseEpoch: job.leaseEpoch }] })
    await sleep(200)
    expect((await taskRow(task.id)).leaseExpiresAt!.getTime()).toBeGreaterThan(before.getTime())
    expect(await runRow(job.runId)).toMatchObject({ state: 'running', agentSessionId: 'sess-1' })
    await pause(project)
  })

  it('stores the token totals of the last usage event, with cache reads apart', async () => {
    const { project, job } = await assigned()
    runner.send({
      type: 'run.events', runId: job.runId, leaseEpoch: job.leaseEpoch, events: [
        { type: 'usage', inputTokens: 100, cacheReadTokens: 5000, outputTokens: 10 },
        { type: 'message', text: 'Working' },
        { type: 'usage', inputTokens: 120, cacheReadTokens: 9000, outputTokens: 30 }
      ]
    })
    await sleep(200)
    expect(await runRow(job.runId)).toMatchObject({ inputTokens: 120, cacheReadTokens: 9000, outputTokens: 30 })
    await pause(project)
  })

  it('interrupts a run whose lease expired and leaves the task for a retry (D10)', async () => {
    const { project, task, job } = await assigned()
    t.clock.now = new Date(t.clock.now.getTime() + 16 * 60_000)
    await t.orchestrator.sweepLeases()
    expect(await runRow(job.runId)).toMatchObject({ state: 'interrupted' })
    // An older runner sends no timings
    const run = await t.request('GET', `/api/runs/${job.runId}`).then(r => r.json()) as Run
    expect(run).toMatchObject({ state: 'interrupted', timings: null })
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress', leaseRunId: null, failedRuns: 0 })
    await runner.next('run.stop', m => m.runId === job.runId)
    // A heartbeat for the dead run is told to stop
    runner.send({ type: 'heartbeat', activeRuns: [{ runId: job.runId, leaseEpoch: job.leaseEpoch }] })
    await runner.next('run.stop', m => m.runId === job.runId)
    await pause(project)
  })

  it('rejects tool calls with a stale epoch', async () => {
    const { project, task, job } = await assigned()
    const stale = await runner.call(job.runId, job.leaseEpoch - 1, 'get_task', {})
    expect(stale).toMatchObject({ ok: false, error: expect.stringContaining('no longer holds its task') })
    const fresh = await runner.call(job.runId, job.leaseEpoch, 'get_task', {})
    expect(fresh).toMatchObject({ ok: true, result: { ref: task.ref, status: 'in_progress', attachments: [] } })
    await pause(project)
  })

  it('rejects a submission with missing evidence or a branch at the wrong commit, saying what is missing', async () => {
    const { project, task, job } = await assigned({ acceptanceCriteria: ['Shows an error on a bad password', 'Logs in with the right one'] })
    const criteria = (await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}`).then(r => r.json()) as Task).acceptanceCriteria

    expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_rebased', note: 'Rebased', summary: 'Resolved conflicts', headSha: 'abc123' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('pr_opened or pr_updated') })
    const noCommit = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', note: 'Did the work', summary: 'Done' })
    expect(noCommit).toMatchObject({ ok: false, error: expect.stringContaining('no commit') })

    t.github.setBranch(project.repository, job.branch!, 'abc123')
    const noEvidence = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', note: 'Did the work', summary: 'Done', headSha: 'abc123' })
    expect(noEvidence).toMatchObject({ ok: false, error: expect.stringContaining('No evidence yet for') })
    expect((noEvidence as { error: string }).error).toContain(criteria[1]!.text)

    const attach = await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', {
      criterionId: criteria[0]!.id, kind: 'test_output', note: 'vitest', fileName: 'test.txt', contentType: 'text/plain', dataBase64: Buffer.from('1 passed').toString('base64')
    })
    expect(attach).toMatchObject({ ok: true })
    const stillMissing = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', note: 'Did the work', summary: 'Done', headSha: 'abc123' })
    expect((stillMissing as { error: string }).error).not.toContain(criteria[0]!.text)
    expect((stillMissing as { error: string }).error).toContain(criteria[1]!.text)

    await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', {
      criterionId: criteria[1]!.id, kind: 'screenshot', fileName: 'login.png', contentType: 'image/png', dataBase64: Buffer.from('png').toString('base64')
    })
    const wrongCommit = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', note: 'Did the work', summary: 'Done', headSha: 'def456' })
    expect(wrongCommit).toMatchObject({ ok: false, error: expect.stringContaining('is at abc123, not your commit def456') })
    expect(t.github.pulls.size).toBe(0)
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress' })
    await pause(project)
  })

  it('opens a PR for a valid submission and moves the task to Agent review', async () => {
    const { project, task, job } = await assigned()
    const criteria = (await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}`).then(r => r.json()) as Task).acceptanceCriteria
    t.github.setBranch(project.repository, job.branch!, 'abc123')
    await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', {
      criterionId: criteria[0]!.id, kind: 'test_output', fileName: 'test.txt', contentType: 'text/plain', dataBase64: Buffer.from('ok').toString('base64')
    })
    const result = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', note: 'Did the work', summary: 'Added login', headSha: 'abc123' })
    expect(result).toMatchObject({ ok: true, result: { pr: `https://github.com/${project.repository}/pull/1` } })

    const pr = t.github.pulls.get(1)!
    expect(pr).toMatchObject({ head: job.branch, base: 'main', title: `${task.ref}: Add login` })
    expect(pr.body).toContain('Added login')
    expect(pr.body).toContain(`http://corral.test/tasks/${task.ref}`)
    expect(await taskRow(task.id)).toMatchObject({ status: 'agent_review', leaseRunId: null, prNumber: 1, headSha: 'abc123' })
    expect(await runRow(job.runId)).toMatchObject({ state: 'completed', outcome: 'pr_opened', headSha: 'abc123' })
    await runner.next('run.stop', m => m.runId === job.runId)

    // The run is over: later calls from it are rejected, and its exit is ignored
    const late = await runner.call(job.runId, job.leaseEpoch, 'add_comment', { body: 'late' })
    expect(late).toMatchObject({ ok: false })
    const timings: RunTimings = {
      totalMs: 1500,
      phases: [{ phase: 'worktree_prepare', durationMs: 500 }, { phase: 'agent_cold_start', durationMs: 900 }, { phase: 'push', durationMs: 100 }],
      tools: [{ tool: 'Bash', count: 2, totalMs: 300, maxMs: 200 }]
    }
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'stopped' }, headSha: 'abc123', timings })
    await sleep(200)
    expect(await runRow(job.runId)).toMatchObject({ state: 'completed', outcome: 'pr_opened' })
    // The exit is ignored, but its timings are the run's record
    expect(await t.request('GET', `/api/runs/${job.runId}`).then(r => r.json())).toMatchObject({ timings })
    const evidence = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/evidence`).then(r => r.json()) as { id: string, url: string }[]
    expect(evidence).toHaveLength(1)
    const file = await t.request('GET', evidence[0]!.url)
    expect(await file.text()).toBe('ok')
    await pause(project)
  })

  it('pauses the developer until the reset time on a usage limit, without counting a failure (D3)', async () => {
    const { project, task, job } = await assigned()
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'rate_limited', resetsAt: '2030-01-01T15:00:00Z' }, headSha: null })
    await sleep(200)
    expect(await runRow(job.runId)).toMatchObject({ state: 'completed', outcome: 'rate_limited', rateLimitResetAt: new Date('2030-01-01T15:00:00Z') })
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress', leaseRunId: null, failedRuns: 0 })
    const [atlas] = await t.db.select().from(agents).where(eq(agents.role, 'developer'))
    expect(atlas!.pausedUntil).toEqual(new Date('2030-01-01T15:00:00Z'))
    // Nothing is claimed while paused
    await t.orchestrator.schedule()
    expect(runner.received.filter(m => m.type === 'run.assign' && m.job.taskId === task.id)).toHaveLength(0)
    await t.db.update(agents).set({ pausedUntil: null }).where(eq(agents.id, atlas!.id))
    await pause(project)
  })

  it('says on the run and in the task history what cut the run off', async () => {
    const lastActivityAt = '2026-10-30T11:02:55.000Z'
    const cases = [
      { exit: { kind: 'timed_out', limitSeconds: 3600 }, state: 'failed', error: 'The run hit its time limit of 60 minutes' },
      { exit: { kind: 'stopped', reason: 'The server no longer recognises this run' }, state: 'interrupted', error: 'Stopped by the server: The server no longer recognises this run' },
      { exit: { kind: 'runner_shutdown' }, state: 'interrupted', error: 'The runner shut down' },
      { exit: { kind: 'signalled', signal: 'SIGTERM' }, state: 'failed', error: 'The agent was killed by SIGTERM, which came from outside Corral' }
    ] as const
    for (const { exit, state, error } of cases) {
      const { project, task, job } = await assigned()
      runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit, headSha: null, lastActivityAt })
      await sleep(200)
      const run = await runRow(job.runId)
      expect(run.state).toBe(state)
      expect(run.error).toContain(error)
      expect(run.error).toContain(lastActivityAt)
      const history = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/history`).then(r => r.json()) as { action: string, detail: { error?: string } }[]
      expect(history.find(e => e.action === 'run.ended')?.detail.error).toBe(run.error)
      await pause(project)
    }
  })

  // Frees the developer's slot for the next test
  async function finish(project: Project, job: RunJob) {
    await pause(project)
    await t.request('POST', `/api/runs/${job.runId}/stop`)
  }

  it('asks a human stop to keep the work, and gives the retry the WIP commit and the stop reason', async () => {
    const { project, task, job } = await assigned()
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'session-1' })
    await sleep(100)
    const res = await t.request('POST', `/api/runs/${job.runId}/stop`)
    expect(res.status).toBeLessThan(300)
    expect(await runner.next('run.stop', m => m.runId === job.runId)).toMatchObject({ keepWork: true })

    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'stopped', reason: 'Stopped by a human' }, headSha: 'wip123', wipSha: 'wip123' })
    await expect.poll(async () => (await runRow(job.runId)).headSha).toBe('wip123')
    expect(await runRow(job.runId)).toMatchObject({ state: 'interrupted', error: 'Stopped by a human' })

    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/resume`)).status).toBe(200)
    const retry = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.runId !== job.runId)).job
    expect(retry.continueFrom).toBe('wip123')
    for (const prompt of [retry.prompt, retry.fallbackPrompt!]) {
      expect(prompt).toContain(`You are continuing run #${job.runNumber}, which stopped before it reported an outcome. Stop reason: Stopped by a human`)
      expect(prompt).toContain('WIP commit `wip123`')
    }
    await finish(project, retry)
  })

  it('gives the retry of a timed-out run its reason, and no commit when there was nothing to save', async () => {
    const { project, task, job } = await assigned()
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'session-1' })
    await sleep(100)
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'timed_out', limitSeconds: 3600 }, headSha: 'base', wipSha: null })

    const retry = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.runId !== job.runId)).job
    expect(retry.continueFrom).toBeNull()
    expect(retry.prompt).toContain('Stop reason: The run hit its time limit of 60 minutes')
    expect(retry.prompt).toContain('No WIP commit is recorded yet')
    await finish(project, retry)
  })

  it('carries a WIP commit to another developer without a resumable session', async () => {
    const { project, task, job } = await assigned()
    // The stopped run belongs to another developer and never acquired a session.
    const [other] = await t.db.insert(agents).values({ name: 'Other developer', role: 'developer', runtime: 'claude-code', paused: true }).returning()
    await t.db.update(runs).set({ agentId: other!.id, agentSessionId: null }).where(eq(runs.id, job.runId))
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'timed_out', limitSeconds: 3600 }, headSha: 'wip-other', wipSha: 'wip-other' })
    const retry = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.runId !== job.runId)).job
    expect(retry.agentSessionId).toBeNull()
    expect(retry.continueFrom).toBe('wip-other')
    expect(retry.prompt).toContain('Continuing a stopped run')
    expect(retry.prompt).toContain('Stop reason: The run hit its time limit')
    expect((await runRow(job.runId)).headSha).toBe('wip-other')
    await finish(project, retry)
  })

  it('does not describe an agent-reported failure as a stopped run', async () => {
    const { project, task, job } = await assigned()
    expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'failed', summary: 'Cannot implement this', note: 'Gave up' })).toMatchObject({ ok: true })
    const retry = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.runId !== job.runId)).job
    expect(retry.prompt).not.toContain('Continuing a stopped run')
    expect(retry.continueFrom).toBeNull()
    expect((await runRow(job.runId)).summary).toBe('Cannot implement this')
    await finish(project, retry)
  })

  it('acknowledges lease ownership using the runner clock and rejects an overdue heartbeat', async () => {
    const { project, task, job } = await assigned()
    const sentAt = 1234 // Deliberately different from the server clock.
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: null, sentAt })
    expect(await runner.next('run.lease', m => m.runId === job.runId)).toMatchObject({ leaseEpoch: job.leaseEpoch, validUntil: new Date(sentAt + 60_000).toISOString() })
    runner.send({ type: 'heartbeat', activeRuns: [{ runId: job.runId, leaseEpoch: job.leaseEpoch }], sentAt: sentAt + 10 })
    expect(await runner.next('run.lease', m => m.runId === job.runId)).toMatchObject({ validUntil: new Date(sentAt + 60_010).toISOString() })
    await t.db.update(tasks).set({ leaseExpiresAt: new Date(t.clock.now.getTime() - 1) }).where(eq(tasks.id, task.id))
    runner.send({ type: 'heartbeat', activeRuns: [{ runId: job.runId, leaseEpoch: job.leaseEpoch }], sentAt: sentAt + 20 })
    expect(await runner.next('run.stop', m => m.runId === job.runId)).toMatchObject({ reason: 'This run no longer holds its lease' })
    expect((await taskRow(task.id)).leaseExpiresAt!.getTime()).toBeLessThan(t.clock.now.getTime())
    await finish(project, job)
  })

  it('lets a human-stopped run finish saving through a heartbeat, until the task moves on', async () => {
    const { project, task, job } = await assigned()
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'session-1' })
    await sleep(100)
    await t.request('POST', `/api/runs/${job.runId}/stop`)
    await runner.next('run.stop', m => m.runId === job.runId)
    const active = [{ runId: job.runId, leaseEpoch: job.leaseEpoch }]

    // The agent is still exiting, so the runner still lists the run
    await t.orchestrator.onHeartbeat(active, 'r1')
    await sleep(100)
    expect(runner.received.filter(m => m.type === 'run.stop' && m.runId === job.runId)).toEqual([])

    // A retry holds the lease now: the stopped run may no longer push
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/resume`)).status).toBe(200)
    const retry = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.runId !== job.runId)).job
    await t.orchestrator.onHeartbeat(active, 'r1')
    expect((await runner.next('run.stop', m => m.runId === job.runId)).keepWork).toBeUndefined()
    await finish(project, retry)
  })

  it('still revokes a run interrupted by an expired lease', async () => {
    const { project, task, job } = await assigned()
    await t.db.update(tasks).set({ leaseExpiresAt: new Date(Date.now() - 1000) }).where(eq(tasks.id, task.id))
    await t.orchestrator.sweepLeases()
    await runner.next('run.stop', m => m.runId === job.runId)
    await t.orchestrator.onHeartbeat([{ runId: job.runId, leaseEpoch: job.leaseEpoch }], 'r1')
    expect((await runner.next('run.stop', m => m.runId === job.runId)).reason).toBe('This run no longer holds its lease')
    await pause(project)
  })

  it('ignores a WIP commit from a stale lease epoch', async () => {
    const { project, job } = await assigned()
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch - 1, exit: { kind: 'stopped' }, headSha: 'wip123', wipSha: 'wip123' })
    await sleep(200)
    expect((await runRow(job.runId)).headSha).toBeNull()
    await finish(project, job)
  })

  it('adds the last transcript activity to a run the server already stopped', async () => {
    const { project, job } = await assigned()
    await t.orchestrator.stopRun(job.runId, { kind: 'human', userId: 'cormac' })
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'stopped', reason: 'Stopped by a human' }, headSha: null, lastActivityAt: '2026-10-30T11:02:55.000Z' })
    await sleep(200)
    expect(await runRow(job.runId)).toMatchObject({ state: 'interrupted', error: 'Stopped by a human. Last transcript activity: 2026-10-30T11:02:55.000Z' })
    await pause(project)
  })

  it('counts failed runs and fails the task at the cap', async () => {
    const { project, task, job: first } = await assigned()
    let job = first
    for (let attempt = 1; attempt <= 3; attempt++) {
      runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'exited', code: 1 }, headSha: null })
      await sleep(200)
      expect(await runRow(job.runId)).toMatchObject({ state: 'failed', outcome: 'failed' })
      const row = await taskRow(task.id)
      expect(row.failedRuns).toBe(attempt)
      if (attempt < 3) {
        expect(row.status).toBe('in_progress')
        await t.orchestrator.schedule()
        job = (await runner.next('run.assign', m => m.job.taskId === task.id)).job
        expect(job.leaseEpoch).toBe(attempt + 1)
      } else {
        expect(row).toMatchObject({ status: 'failed', statusReason: 'Failed-run cap reached (3)', leaseRunId: null })
      }
    }
    await pause(project)
  })

  it('blocks the task when the agent reports stuck, with the question as the reason', async () => {
    const { project, task, job } = await assigned()
    const result = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'stuck', note: 'Did the work', summary: 'Which OAuth provider?' })
    expect(result).toMatchObject({ ok: true })
    expect(await taskRow(task.id)).toMatchObject({ status: 'blocked', statusReason: 'Which OAuth provider?', leaseRunId: null })
    expect(await runRow(job.runId)).toMatchObject({ state: 'completed', outcome: 'stuck' })
    await pause(project)
  })

  it('rejects a developer outcome without a one-line note, saying what to add', async () => {
    const { project, task, job } = await assigned()
    const missing = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'stuck', summary: 'Which OAuth provider?' })
    expect(missing).toMatchObject({ ok: false, error: expect.stringContaining('The work note is missing. Add `note`: one line of at most 200 characters') })
    const long = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'stuck', note: 'x'.repeat(201), summary: 'Which OAuth provider?' })
    expect(long).toMatchObject({ ok: false, error: expect.stringContaining('The work note is 201 characters; the limit is 200.') })
    const lines = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'failed', note: 'Tried\nGave up', summary: 'Broken' })
    expect(lines).toMatchObject({ ok: false, error: expect.stringContaining('single line') })
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress', leaseRunId: job.runId })
    expect(await runRow(job.runId)).toMatchObject({ endedAt: null })
    await pause(project)
  })

  it('posts the developer’s note as a comment by its agent with the outcome', async () => {
    const { project, task, job } = await assigned()
    await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'stuck', note: 'Read the auth module; need a provider decision', summary: 'Which OAuth provider?' })
    const notes = await t.db.select().from(comments).where(eq(comments.taskId, task.id))
    expect(notes).toMatchObject([{ author: { kind: 'agent', role: 'developer', runId: job.runId }, body: 'Read the auth module; need a provider decision', pinned: false }])
    await pause(project)
  })

  it('posts the note of a failed developer run', async () => {
    const { project, task, job } = await assigned()
    await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'failed', note: 'Install fails on a missing native module', summary: 'Broken toolchain' })
    expect(await runRow(job.runId)).toMatchObject({ state: 'failed', outcome: 'failed' })
    const notes = await t.db.select().from(comments).where(eq(comments.taskId, task.id))
    expect(notes).toMatchObject([{ author: { kind: 'agent', role: 'developer', runId: job.runId }, body: 'Install fails on a missing native module' }])
    await pause(project)
  })

  it('reconciles on reconnect: runs the runner lost are interrupted, unknown ones are stopped', async () => {
    const { project, task, job } = await assigned()
    runner.close()
    runner = await FakeRunner.connect(t.server!.url, [{ runId: 'ghost', leaseEpoch: 1 }], 'r1', { slots: 50 })
    // The ghost is stopped only after all lost runs have been reconciled.
    // Earlier tests leave live runs behind, so a fixed delay can inspect
    // this run before reconciliation has reached it on a busy machine.
    await runner.next('run.stop', m => m.runId === 'ghost')
    expect(await runRow(job.runId)).toMatchObject({ state: 'interrupted' })
    // Reconciling freed the task, so the scheduler gave it a new run and epoch
    const again = await runner.next('run.assign', m => m.job.taskId === task.id)
    expect(again.job.leaseEpoch).toBe(job.leaseEpoch + 1)
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress', leaseRunId: again.job.runId, failedRuns: 0 })
    await pause(project)
  })

  // A developer submission accepted by the server: the task is in Agent review
  async function submitted(input: Parameters<TestApp['createTask']>[1] = {}) {
    const { project, task, job } = await assigned(input)
    const full = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}`).then(r => r.json()) as Task
    t.github.setBranch(project.repository, job.branch!, 'abc123')
    for (const criterion of full.acceptanceCriteria) {
      await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', {
        criterionId: criterion.id, kind: 'screenshot', note: 'the page', fileName: 'shot.png', contentType: 'image/png', dataBase64: Buffer.from('png-bytes').toString('base64')
      })
    }
    const result = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', note: 'Did the work', summary: 'Implemented', headSha: 'abc123' })
    expect(result).toMatchObject({ ok: true })
    await runner.next('run.stop', m => m.runId === job.runId)
    return { project, task: full, developer: job }
  }

  // ...and the reviewer run the scheduler starts for it
  async function underReview(input: Parameters<TestApp['createTask']>[1] = {}) {
    const state = await submitted(input)
    await t.orchestrator.schedule()
    const review = (await runner.next('run.assign', m => m.job.taskId === state.task.id && m.job.role === 'reviewer')).job
    return { ...state, review }
  }

  it('tells the reviewer whether the project has required checks (D26)', async () => {
    const { review } = await underReview()
    expect(review.prompt).toContain('This project has no required CI checks')

    const { project, task } = await submitted()
    await t.request('PATCH', `/api/projects/${project.slug}`, { requiredChecks: ['ci'] })
    await t.orchestrator.schedule()
    const next = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'reviewer')).job
    expect(next.prompt).toContain('This project has required CI checks: `ci`')
  })

  it('claims an Agent review task for the reviewer at the submitted commit', async () => {
    const { project, task, review } = await underReview()
    expect(review).toMatchObject({ role: 'reviewer', runtime: 'claude-code', headSha: 'abc123', branch: task.branch, leaseEpoch: 2 })
    expect(review.prompt).toContain('commit abc123')
    expect(review.prompt).toContain('shot.png')
    expect(await taskRow(task.id)).toMatchObject({ status: 'agent_review', leaseRole: 'reviewer', leaseRunId: review.runId })

    const list = await runner.call(review.runId, review.leaseEpoch, 'get_evidence', {})
    expect(list).toMatchObject({ ok: true, result: { round: 0, evidence: [{ kind: 'screenshot', fileName: 'shot.png' }] } })
    const id = (list as { result: { evidence: { id: string }[] } }).result.evidence[0]!.id
    const item = await runner.call(review.runId, review.leaseEpoch, 'get_evidence', { evidenceId: id })
    expect(item).toMatchObject({ ok: true, result: { id, images: [{ mimeType: 'image/png', dataBase64: Buffer.from('png-bytes').toString('base64') }] } })
    await pause(project)
  })

  it('records a note as evidence without a file, accepts a submission covered by notes, and shows the text to the reviewer (D21)', async () => {
    const { project, task, job } = await assigned({ acceptanceCriteria: ['Login works as before', 'Uses the new helper'] })
    const criteria = (await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}`).then(r => r.json()) as Task).acceptanceCriteria
    t.github.setBranch(project.repository, job.branch!, 'abc123')
    const blobsBefore = t.blobs.size
    for (const [i, criterion] of criteria.entries()) {
      const attach = await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', { criterionId: criterion.id, kind: 'note', note: `  Refactor only, see src/login.ts:${i + 1}\n` })
      expect(attach).toMatchObject({ ok: true, result: { id: expect.any(String) } })
    }
    expect(t.blobs.size).toBe(blobsBefore)
    const rows = await t.db.select().from(schema.evidence).where(eq(schema.evidence.taskId, task.id)).orderBy(asc(schema.evidence.createdAt))
    expect(rows.map(r => ({ criterionId: r.criterionId, kind: r.kind, note: r.note, blob: r.blob, fileName: r.fileName, contentType: r.contentType, size: r.size }))).toEqual(criteria.map((c, i) => ({
      criterionId: c.id, kind: 'note', note: `Refactor only, see src/login.ts:${i + 1}`, blob: null, fileName: null, contentType: null, size: 0
    })))
    const listed = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/evidence`).then(r => r.json()) as { id: string, url: string | null }[]
    expect(listed.map(e => e.url)).toEqual([null, null])
    expect((await t.request('GET', `/api/evidence/${listed[0]!.id}/file`)).status).toBe(404)

    // Notes alone cover every criterion
    const result = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', note: 'Did the work', summary: 'Refactored login', headSha: 'abc123' })
    expect(result).toMatchObject({ ok: true })
    expect(await taskRow(task.id)).toMatchObject({ status: 'agent_review', headSha: 'abc123' })
    await runner.next('run.stop', m => m.runId === job.runId)

    await t.orchestrator.schedule()
    const review = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'reviewer')).job
    expect(review.prompt).toContain(`note (no file; judge the explanation) for [${criteria[0]!.id}]:\n  Refactor only, see src/login.ts:1`)
    const list = await runner.call(review.runId, review.leaseEpoch, 'get_evidence', {})
    expect(list).toMatchObject({ ok: true, result: { evidence: [{ kind: 'note', fileName: null }, { kind: 'note', fileName: null }] } })
    const item = await runner.call(review.runId, review.leaseEpoch, 'get_evidence', { evidenceId: rows[0]!.id })
    expect(item).toMatchObject({ ok: true, result: { id: rows[0]!.id, kind: 'note', text: 'Refactor only, see src/login.ts:1' } })
    await pause(project)
  })

  it('rejects evidence with no file unless it is a note with text (D21)', async () => {
    const { project, task, job } = await assigned()
    const criterion = (await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}`).then(r => r.json()) as Task).acceptanceCriteria[0]!
    const noFile = await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', { criterionId: criterion.id, kind: 'screenshot', note: 'The page' })
    expect(noFile).toMatchObject({ ok: false, error: expect.stringContaining('Pass the path of the file to attach') })
    for (const fields of [{ fileName: 'x' }, { contentType: 'text/plain' }, { dataBase64: '' }, { size: -1 }, { blob: 'x' }]) {
      expect(await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', { kind: 'note', note: 'Explanation', ...fields })).toMatchObject({ ok: false })
    }
    for (const note of [undefined, '', '   ']) {
      const empty = await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', { criterionId: criterion.id, kind: 'note', ...(note !== undefined && { note }) })
      expect(empty).toMatchObject({ ok: false, error: 'Not attached. A note needs its text: explain how the criterion is met.' })
    }
    expect(await t.db.select().from(schema.evidence).where(eq(schema.evidence.taskId, task.id))).toEqual([])
    await pause(project)
  })

  it('rejects verdicts that skip a criterion or approve with one unmet', async () => {
    const { project, task, review } = await underReview()
    const criterion = task.acceptanceCriteria[0]!
    const none = await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Looks good' })
    expect(none).toMatchObject({ ok: false, error: expect.stringContaining('criteria: Give a verdict for every acceptance criterion') })
    const partial = await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Looks good', criteria: [] })
    expect(partial).toMatchObject({ ok: false, error: expect.stringContaining(criterion.text) })
    const unknown = await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'looks_fine', summary: 'Looks good' })
    expect(unknown).toMatchObject({ ok: false, error: expect.stringContaining('outcome: must be one of pr_opened') })
    const blank = await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'blocked', summary: ' ' })
    expect(blank).toMatchObject({ ok: false, error: expect.stringContaining('summary: Add a summary') })
    const unmet = await runner.call(review.runId, review.leaseEpoch, 'report_outcome', {
      outcome: 'approved', summary: 'Looks good', criteria: [{ criterionId: criterion.id, met: false, note: 'nope' }]
    })
    expect(unmet).toMatchObject({ ok: false, error: expect.stringContaining('every criterion met') })
    expect(await taskRow(task.id)).toMatchObject({ status: 'agent_review', leaseRunId: review.runId })
    await pause(project)
  })

  it('still checks the role after the report parses: a reviewer can\'t open a PR', async () => {
    const { project, task, review } = await underReview()
    const result = await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', summary: 'Opened' })
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining('A reviewer reports') })
    expect(await taskRow(task.id)).toMatchObject({ status: 'agent_review', leaseRunId: review.runId })
    await pause(project)
  })

  it('leaves a run the server stopped ended when run.started arrives late', async () => {
    const { project, job } = await assigned()
    await t.orchestrator.stopRun(job.runId, t.actor)
    runner.send({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'late' })
    await sleep(50)
    expect(await runRow(job.runId)).toMatchObject({ state: 'interrupted', outcome: null, agentSessionId: null })
    await pause(project)
  })

  it('posts changes requested as feedback and sends the task back to the developer', async () => {
    const { project, task, review } = await underReview()
    const criterion = task.acceptanceCriteria[0]!
    const result = await runner.call(review.runId, review.leaseEpoch, 'report_outcome', {
      outcome: 'changes_requested', summary: 'The error message is missing', criteria: [{ criterionId: criterion.id, met: false, note: 'No message shown' }]
    })
    expect(result).toMatchObject({ ok: true })
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress', reviewRounds: 1, leaseRunId: null })
    expect(await runRow(review.runId)).toMatchObject({ state: 'completed', outcome: 'changes_requested', headSha: 'abc123' })
    await runner.next('run.stop', m => m.runId === review.runId)

    const reviews = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/reviews`).then(r => r.json()) as { verdict: string, round: number, headSha: string }[]
    expect(reviews).toMatchObject([{ verdict: 'changes_requested', round: 0, headSha: 'abc123' }])
    const updated = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}`).then(r => r.json()) as Task
    expect(updated.acceptanceCriteria[0]!.met).toBe(false)
    expect(updated.latestReview?.verdict).toBe('changes_requested')

    // The next developer run sees the feedback and is asked for pr_updated
    const next = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'developer')).job
    expect(next.prompt).toContain('No message shown')
    expect(next.prompt).toContain('"pr_updated"')
    await pause(project)
  })

  it('blocks the task when changes are requested at the review-round cap', async () => {
    const { project, task, review } = await underReview()
    await t.db.update(tasks).set({ reviewRounds: 4 }).where(eq(tasks.id, task.id))
    await runner.call(review.runId, review.leaseEpoch, 'report_outcome', {
      outcome: 'changes_requested', summary: 'Still wrong', criteria: [{ criterionId: task.acceptanceCriteria[0]!.id, met: false, note: '' }]
    })
    expect(await taskRow(task.id)).toMatchObject({ status: 'blocked', reviewRounds: 5, statusReason: 'Review-round cap reached (5)' })
    await pause(project)
  })

  // A reviewer requests changes, the developer pushes a new commit, and a
  // second reviewer run starts on it
  async function secondReview(first: { summary: string, note: string }, headSha = 'def456', unblock = false) {
    const { project, task, review } = await underReview()
    const criterion = task.acceptanceCriteria[0]!
    if (unblock) await t.request('PATCH', `/api/projects/${project.slug}`, { reviewRoundCap: 1 })
    await runner.call(review.runId, review.leaseEpoch, 'report_outcome', {
      outcome: 'changes_requested', summary: first.summary, criteria: [{ criterionId: criterion.id, met: false, note: first.note }]
    })
    await runner.next('run.stop', m => m.runId === review.runId)
    if (unblock) {
      expect(await taskRow(task.id)).toMatchObject({ status: 'blocked', reviewRounds: 1 })
      const resolved = await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'resolve', to: 'in_progress' })
      expect(resolved.status).toBe(200)
      expect(await taskRow(task.id)).toMatchObject({ reviewRounds: 0 })
    }
    const developer = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'developer')).job
    t.github.setBranch(project.repository, developer.branch!, headSha)
    await runner.call(developer.runId, developer.leaseEpoch, 'attach_evidence', {
      criterionId: criterion.id, kind: 'screenshot', note: 'the page', fileName: 'shot.png', contentType: 'image/png', dataBase64: Buffer.from('png-bytes').toString('base64')
    })
    expect(await runner.call(developer.runId, developer.leaseEpoch, 'report_outcome', { outcome: 'pr_updated', note: 'Addressed review: showed the error message', summary: 'Fixed', headSha })).toMatchObject({ ok: true })
    await runner.next('run.stop', m => m.runId === developer.runId)
    await t.orchestrator.schedule()
    const second = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'reviewer')).job
    return { project, task, criterion, review: second }
  }

  it('starts a new review on the same commit and shows the new round’s evidence', async () => {
    const { project, task, review } = await secondReview({ summary: 'Show the error', note: 'Evidence missing' }, 'abc123')
    expect(review).toMatchObject({ role: 'reviewer', headSha: 'abc123' })
    expect(await taskRow(task.id)).toMatchObject({ reviewRounds: 1, leaseRunId: review.runId })
    const allEvidence = await t.db.select().from(schema.evidence).where(eq(schema.evidence.taskId, task.id)).orderBy(asc(schema.evidence.round))
    expect(allEvidence.map(e => e.round)).toEqual([0, 1])
    const current = allEvidence[1]!
    expect(await runner.call(review.runId, review.leaseEpoch, 'get_evidence', {})).toMatchObject({
      ok: true, result: { round: 1, evidence: expect.arrayContaining([expect.objectContaining({ id: current.id, round: 1 })]) }
    })
    expect(review.prompt).toContain(current.id)
    expect(review.prompt).not.toContain(allEvidence[0]!.id)
    await pause(project)
  })

  it('starts a reviewer after human resolution and same-head resubmission with the round cap reset', async () => {
    const { project, task, criterion, review } = await secondReview({ summary: 'Needs evidence', note: 'Show the page' }, 'abc123', true)
    expect(review).toMatchObject({ role: 'reviewer', headSha: 'abc123' })
    expect(await taskRow(task.id)).toMatchObject({ reviewRounds: 0, leaseRunId: review.runId })
    await runner.call(review.runId, review.leaseEpoch, 'report_outcome', {
      outcome: 'changes_requested', summary: 'A different issue', criteria: [{ criterionId: criterion.id, met: false, note: 'Fix the label' }]
    })
    expect(await taskRow(task.id)).toMatchObject({ status: 'blocked', reviewRounds: 1, statusReason: 'Review-round cap reached (1)' })
    await pause(project)
  })

  async function reviewAudit(taskId: string) {
    return t.db.select().from(auditLog).where(and(eq(auditLog.taskId, taskId), eq(auditLog.action, 'review.recorded'))).orderBy(asc(auditLog.id))
  }

  it('blocks the task when the reviewer repeats the previous round’s feedback', async () => {
    const { project, task, criterion, review } = await secondReview({ summary: 'The error message is missing when the form is submitted empty', note: 'No message shown' })
    const result = await runner.call(review.runId, review.leaseEpoch, 'report_outcome', {
      outcome: 'changes_requested', summary: 'The error message is still missing when the form is submitted empty.', criteria: [{ criterionId: criterion.id, met: false, note: 'No message shown' }]
    })
    expect(result).toMatchObject({ ok: true, result: { message: expect.stringContaining('Blocked') } })
    expect(await taskRow(task.id)).toMatchObject({ status: 'blocked', reviewRounds: 2, statusReason: 'The reviewer asked for the same changes twice', leaseRunId: null })
    const audit = await reviewAudit(task.id)
    expect(audit.map(a => (a.detail as { similarity?: number }).similarity)).toEqual([undefined, expect.any(Number)])
    expect((audit[1]!.detail as { similarity: number }).similarity).toBeGreaterThanOrEqual(0.8)

    // It needs the human, like any other Blocked task
    const inbox = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    expect(inbox.needsYou.find(i => i.taskId === task.id)).toMatchObject({ type: 'blocked', body: 'The reviewer asked for the same changes twice' })
    await pause(project)
  })

  it('lists the developer’s notes in order with the reviewer’s feedback in get_task', async () => {
    const { project, review } = await secondReview({ summary: 'The error message is missing', note: 'No message shown' })
    const task = await runner.call(review.runId, review.leaseEpoch, 'get_task', {}) as { result: { comments: { author: string, body: string }[] } }
    expect(task.result.comments.map(c => [c.author, c.body.split('\n')[0]])).toEqual([
      ['Developer', 'Did the work'],
      ['Reviewer', 'The error message is missing'],
      ['Developer', 'Addressed review: showed the error message']
    ])
    await pause(project)
  })

  it('sends the task back to the developer when the new feedback is different', async () => {
    const { project, task, criterion, review } = await secondReview({ summary: 'The error message is missing when the form is submitted empty', note: 'No message shown' })
    await runner.call(review.runId, review.leaseEpoch, 'report_outcome', {
      outcome: 'changes_requested', summary: 'The message shows now, but the README still describes the old command', criteria: [{ criterionId: criterion.id, met: false, note: 'Update the README' }]
    })
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress', reviewRounds: 2, statusReason: null })
    const audit = await reviewAudit(task.id)
    expect((audit[1]!.detail as { similarity: number }).similarity).toBeLessThan(0.8)
    await pause(project)
  })

  it('records an approval and moves an unflagged task to Ready to merge', async () => {
    const { project, task, review } = await underReview()
    const result = await runner.call(review.runId, review.leaseEpoch, 'report_outcome', {
      outcome: 'approved', summary: 'All good', criteria: [{ criterionId: task.acceptanceCriteria[0]!.id, met: true, note: 'Seen in shot.png' }]
    })
    expect(result).toMatchObject({ ok: true })
    expect(await taskRow(task.id)).toMatchObject({ status: 'ready_to_merge', reviewRounds: 0, leaseRunId: null })
    const updated = await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}`).then(r => r.json()) as Task
    expect(updated.acceptanceCriteria[0]!.met).toBe(true)
    // The commit has its verdict, so the reviewer isn't started again
    await t.orchestrator.schedule()
    expect(runner.received.filter(m => m.type === 'run.assign' && m.job.taskId === task.id)).toHaveLength(0)
    await pause(project)
  })

  it('stops a run on request and pauses the task', async () => {
    const { project, task, job } = await assigned()
    const res = await t.request('POST', `/api/runs/${job.runId}/stop`)
    expect(res.status).toBe(200)
    await runner.next('run.stop', m => m.runId === job.runId)
    expect(await runRow(job.runId)).toMatchObject({ state: 'interrupted' })
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress', paused: true, leaseRunId: null })
    await pause(project)
  })
})
