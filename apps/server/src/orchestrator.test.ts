import type { Project, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq, ne } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner, sleep } from './test-runner.ts'

const { agents, runs, tasks } = schema

// Concurrency and leases: Postgres only (D14)
describe('orchestrator', () => {
  let t: TestApp
  let runner: FakeRunner

  beforeAll(async () => {
    t = await createTestApp('postgres', { listen: true })
    // Each test leaves its run live, so the one developer must have room for all of them
    await t.db.update(agents).set({ concurrency: 50 }).where(ne(agents.role, 'pm'))
    runner = await FakeRunner.connect(t.server!.url)
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
    await t.db.update(agents).set({ runtime: 'other-cli' }).where(eq(agents.role, 'developer'))
    try {
      const { project, job } = await assigned()
      expect(job.runtime).toBe('other-cli')
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

  it('interrupts a run whose lease expired and leaves the task for a retry (D10)', async () => {
    const { project, task, job } = await assigned()
    t.clock.now = new Date(t.clock.now.getTime() + 16 * 60_000)
    await t.orchestrator.sweepLeases()
    expect(await runRow(job.runId)).toMatchObject({ state: 'interrupted' })
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
    expect(fresh).toMatchObject({ ok: true, result: { ref: task.ref, status: 'in_progress' } })
    await pause(project)
  })

  it('rejects a submission with missing evidence or a branch at the wrong commit, saying what is missing', async () => {
    const { project, task, job } = await assigned({ acceptanceCriteria: ['Shows an error on a bad password', 'Logs in with the right one'] })
    const criteria = (await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}`).then(r => r.json()) as Task).acceptanceCriteria

    const noCommit = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', summary: 'Done' })
    expect(noCommit).toMatchObject({ ok: false, error: expect.stringContaining('no commit') })

    t.github.setBranch(project.repository, job.branch!, 'abc123')
    const noEvidence = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', summary: 'Done', headSha: 'abc123' })
    expect(noEvidence).toMatchObject({ ok: false, error: expect.stringContaining('No evidence yet for') })
    expect((noEvidence as { error: string }).error).toContain(criteria[1]!.text)

    const attach = await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', {
      criterionId: criteria[0]!.id, kind: 'test_output', note: 'vitest', fileName: 'test.txt', contentType: 'text/plain', dataBase64: Buffer.from('1 passed').toString('base64')
    })
    expect(attach).toMatchObject({ ok: true })
    const stillMissing = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', summary: 'Done', headSha: 'abc123' })
    expect((stillMissing as { error: string }).error).not.toContain(criteria[0]!.text)
    expect((stillMissing as { error: string }).error).toContain(criteria[1]!.text)

    await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', {
      criterionId: criteria[1]!.id, kind: 'screenshot', fileName: 'login.png', contentType: 'image/png', dataBase64: Buffer.from('png').toString('base64')
    })
    const wrongCommit = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', summary: 'Done', headSha: 'def456' })
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
    const result = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', summary: 'Added login', headSha: 'abc123' })
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
    runner.send({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, exit: { kind: 'stopped' }, headSha: 'abc123' })
    await sleep(200)
    expect(await runRow(job.runId)).toMatchObject({ state: 'completed', outcome: 'pr_opened' })
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
    const result = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'stuck', summary: 'Which OAuth provider?' })
    expect(result).toMatchObject({ ok: true })
    expect(await taskRow(task.id)).toMatchObject({ status: 'blocked', statusReason: 'Which OAuth provider?', leaseRunId: null })
    expect(await runRow(job.runId)).toMatchObject({ state: 'completed', outcome: 'stuck' })
    await pause(project)
  })

  it('reconciles on reconnect: runs the runner lost are interrupted, unknown ones are stopped', async () => {
    const { project, task, job } = await assigned()
    runner.close()
    runner = await FakeRunner.connect(t.server!.url, [{ runId: 'ghost', leaseEpoch: 1 }])
    await sleep(200)
    expect(await runRow(job.runId)).toMatchObject({ state: 'interrupted' })
    await runner.next('run.stop', m => m.runId === 'ghost')
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
    const result = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', summary: 'Implemented', headSha: 'abc123' })
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

  it('rejects verdicts that skip a criterion or approve with one unmet', async () => {
    const { project, task, review } = await underReview()
    const criterion = task.acceptanceCriteria[0]!
    const none = await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Looks good' })
    expect(none).toMatchObject({ ok: false, error: expect.stringContaining(criterion.text) })
    const unmet = await runner.call(review.runId, review.leaseEpoch, 'report_outcome', {
      outcome: 'approved', summary: 'Looks good', criteria: [{ criterionId: criterion.id, met: false, note: 'nope' }]
    })
    expect(unmet).toMatchObject({ ok: false, error: expect.stringContaining('every criterion met') })
    expect(await taskRow(task.id)).toMatchObject({ status: 'agent_review', leaseRunId: review.runId })
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
