import type { Inbox, Comment, Project, RunJob, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { and, eq } from 'drizzle-orm'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

const { agents, auditLog, runs, tasks } = schema

// D19: a spike delivers findings instead of a PR. Each test runs a task from
// approval to its end against a fake runner and fake GitHub, so the spike
// path and the plain path are checked side by side.
describe('spikes deliver findings instead of a PR', () => {
  let t: TestApp
  let runner: FakeRunner

  beforeAll(async () => {
    t = await createTestApp('pglite', { listen: true })
    // Each test leaves its project paused, so agents need room for all of them
    await t.db.update(agents).set({ concurrency: 50 })
    runner = await FakeRunner.connect(t.server!.url)
  })

  afterAll(async () => {
    runner?.close()
    await t?.close()
  })

  const FINDINGS = '**Answer:** Postgres advisory locks are enough.\n\n**Evidence:** see lock-test.txt.\n\n**Recommendation:** use them.\n\n**Suggested follow-up tasks:** Add advisory locks to the scheduler.'

  async function taskRow(id: string) {
    const [row] = await t.db.select().from(tasks).where(eq(tasks.id, id))
    return row!
  }

  async function full(project: Project, task: Task): Promise<Task> {
    return t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}`).then(r => r.json()) as Promise<Task>
  }

  async function commentsOf(project: Project, task: Task): Promise<Comment[]> {
    return t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}/comments`).then(r => r.json()) as Promise<Comment[]>
  }

  async function nextJob(task: Task, role: RunJob['role']): Promise<RunJob> {
    await t.orchestrator.schedule()
    return (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === role)).job
  }

  async function approved(input: Parameters<TestApp['createTask']>[1] = {}) {
    const project = await t.createProject()
    const task = await t.createTask(project.slug, { title: 'Can we lock with Postgres?', type: 'spike', humanReview: false, acceptanceCriteria: ['Says whether advisory locks are enough', 'Names the follow-up work'], ...input })
    // Creation enables mandatory review; turn the stored flag off to also
    // cover existing spikes and later edits that disable it.
    expect((await t.request('PATCH', `/api/projects/${project.slug}/tasks/${task.number}`, { humanReview: input.humanReview ?? false })).status).toBe(200)
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })).status).toBe(200)
    return { project, task: await full(project, task) }
  }

  async function attachAll(job: RunJob, task: Task) {
    for (const criterion of task.acceptanceCriteria) {
      const result = await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', {
        criterionId: criterion.id, kind: 'test_output', note: 'experiment', fileName: 'lock-test.txt', contentType: 'text/plain', dataBase64: Buffer.from('2 runs, 0 overlaps').toString('base64')
      })
      expect(result).toMatchObject({ ok: true })
    }
  }

  async function reportFindings(job: RunJob, task: Task, findings = FINDINGS) {
    await attachAll(job, task)
    const result = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'findings_reported', note: 'Did the work', summary: findings })
    expect(result).toMatchObject({ ok: true })
    await runner.next('run.stop', m => m.runId === job.runId)
  }

  function verdicts(task: Task, met: boolean[]) {
    return task.acceptanceCriteria.map((c, i) => ({ criterionId: c.id, met: met[i]!, note: met[i] ? 'Answered' : 'Not answered' }))
  }

  async function pause(project: Project) {
    await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  }

  it.each([false, true])('runs a spike end to end with no branch or PR (humanReview=%s), and ends in Merged with the findings on the task', async (humanReview) => {
    const { project, task } = await approved({ humanReview })

    const dependent = await t.createTask(project.slug, { title: 'Implement locking', dependsOn: [task.number] })
    expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${dependent.number}/transitions`, { type: 'approve' })).status).toBe(200)
    await t.orchestrator.schedule()
    expect(runner.received.some(m => m.type === 'run.assign' && m.job.taskId === dependent.id)).toBe(false)

    // The developer gets no branch and is told to investigate and report findings
    const developer = await nextJob(task, 'developer')
    expect(developer).toMatchObject({ branch: null, headSha: null })
    expect(developer.prompt).toContain(`spike ${task.ref}`)
    expect(developer.prompt).toContain('"findings_reported"')
    expect(developer.prompt).toContain('**Suggested follow-up tasks**')
    expect(developer.prompt).not.toContain('pr_opened')

    // A spike can't open a PR, and still needs evidence for every criterion
    expect(await runner.call(developer.runId, developer.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', note: 'Did the work', summary: 'Done', headSha: 'abc' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('findings_reported') })
    expect(await runner.call(developer.runId, developer.leaseEpoch, 'report_outcome', { outcome: 'findings_reported', note: 'Did the work', summary: FINDINGS }))
      .toMatchObject({ ok: false, error: expect.stringContaining('No evidence yet for') })
    await reportFindings(developer, task)

    let row = await taskRow(task.id)
    expect(row).toMatchObject({ status: 'agent_review', branch: null, prNumber: null, prUrl: null })
    const [run] = await t.db.select().from(runs).where(eq(runs.id, developer.runId))
    expect(run).toMatchObject({ state: 'completed', outcome: 'findings_reported', summary: FINDINGS, headSha: null })

    // The reviewer checks the findings, with no commit to check out
    const reviewer = await nextJob(task, 'reviewer')
    expect(reviewer).toMatchObject({ branch: null, headSha: null })
    expect(reviewer.prompt).toContain('## Findings under review')
    expect(reviewer.prompt).toContain('Postgres advisory locks are enough')
    expect(reviewer.prompt).toContain('lock-test.txt')
    expect(reviewer.prompt).not.toContain('git diff')
    const result = await runner.call(reviewer.runId, reviewer.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Answers both.', criteria: verdicts(task, [true, true]) })
    expect(result).toMatchObject({ ok: true, result: { message: expect.stringContaining('A human reviews the findings next.') } })

    expect(await taskRow(task.id)).toMatchObject({ status: 'human_review', humanReview, mergedAt: null })
    expect(runner.received.filter(m => m.type === 'job.request' && m.job.kind === 'cleanup_worktrees' && m.job.taskId === task.id)).toHaveLength(0)
    expect((await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'approve' })).status).toBe(200)

    // Merged, the final column, without GitHub: nothing pushed, opened or merged
    row = await taskRow(task.id)
    expect(row).toMatchObject({ status: 'merged', branch: null, prNumber: null })
    expect(row.mergedAt).not.toBeNull()
    const inbox = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    expect(inbox.needsYou.some(i => i.taskId === task.id)).toBe(false)
    expect(inbox.resolved.find(i => i.taskId === task.id)?.resolution).toBe('You accepted the findings')
    expect(t.github.pulls.size).toBe(0)
    expect(runner.received.filter(m => m.type === 'job.request' && m.job.kind === 'github')).toHaveLength(0)
    await expect.poll(() => runner.received.filter(m => m.type === 'job.request' && m.job.kind === 'cleanup_worktrees' && m.job.taskId === task.id).length).toBe(1)
    await runner.next('job.request', m => m.job.kind === 'cleanup_worktrees' && m.job.taskId === task.id)

    // The findings are a comment on the task, which task detail shows
    const comments = await commentsOf(project, task)
    expect(comments.find(c => c.body.startsWith('## Findings'))).toMatchObject({ author: { kind: 'agent', role: 'developer' }, body: `## Findings\n\n${FINDINGS}` })
    const detail = await full(project, task)
    expect(detail).toMatchObject({ status: 'merged', prUrl: null })
    expect(detail.acceptanceCriteria.every(c => c.met)).toBe(true)

    // Finishing the spike releases its dependent for developer work.
    expect((await nextJob(dependent, 'developer')).taskId).toBe(dependent.id)

    // Finished: nothing more is claimed for it
    await t.orchestrator.schedule()
    expect(runner.received.filter(m => m.type === 'run.assign' && m.job.taskId === task.id)).toHaveLength(0)
    await pause(project)
  })

  it('accepts findings whose criteria are covered by notes alone (D21)', async () => {
    const { project, task } = await approved()
    const developer = await nextJob(task, 'developer')
    for (const criterion of task.acceptanceCriteria) {
      expect(await runner.call(developer.runId, developer.leaseEpoch, 'attach_evidence', { criterionId: criterion.id, kind: 'note', note: 'Read the locking code in src/claim.ts' }))
        .toMatchObject({ ok: true })
    }
    expect(await runner.call(developer.runId, developer.leaseEpoch, 'report_outcome', { outcome: 'findings_reported', note: 'Did the work', summary: FINDINGS })).toMatchObject({ ok: true })
    expect(await taskRow(task.id)).toMatchObject({ status: 'agent_review' })
    await runner.next('run.stop', m => m.runId === developer.runId)
    await pause(project)
  })

  it('sends findings that miss a criterion back to the developer, like a failed review, and reviews the new findings', async () => {
    const { project, task } = await approved()
    const developer = await nextJob(task, 'developer')
    await reportFindings(developer, task, '**Answer:** Advisory locks are enough.')

    const reviewer = await nextJob(task, 'reviewer')
    // Approving with a criterion unanswered is refused
    expect(await runner.call(reviewer.runId, reviewer.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Fine', criteria: verdicts(task, [true, false]) }))
      .toMatchObject({ ok: false, error: expect.stringContaining('every criterion met') })
    expect(await runner.call(reviewer.runId, reviewer.leaseEpoch, 'report_outcome', { outcome: 'changes_requested', summary: 'No follow-up work named.', criteria: verdicts(task, [true, false]) }))
      .toMatchObject({ ok: true })
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress', reviewRounds: 1 })
    await runner.next('run.stop', m => m.runId === reviewer.runId)

    // The developer gets the feedback, still on no branch, and reports again
    const revision = await nextJob(task, 'developer')
    expect(revision).toMatchObject({ branch: null })
    expect(revision.prompt).toContain('No follow-up work named.')
    expect(revision.prompt).toContain('requested changes to your findings')
    await reportFindings(revision, task)

    // The new findings get their own review
    const second = await nextJob(task, 'reviewer')
    expect(second.prompt).toContain('Suggested follow-up tasks')
    expect(second.prompt).toContain('Your feedback last round')
    await runner.call(second.runId, second.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Now complete.', criteria: verdicts(task, [true, true]) })
    expect(await taskRow(task.id)).toMatchObject({ status: 'human_review', reviewRounds: 1 })
    const inbox = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    expect(inbox.needsYou.find(i => i.id === task.id)).toMatchObject({ body: `## Findings\n\n${FINDINGS}`, preview: `## Findings\n\n${FINDINGS}`.slice(0, 200) })
    const findings = (await commentsOf(project, task)).filter(c => c.body.startsWith('## Findings'))
    expect(findings).toHaveLength(2)
    expect(t.github.pulls.size).toBe(0)
    await pause(project)
  })

  it('always stops a spike for human feedback, then delivers that feedback to the developer', async () => {
    const { project, task } = await approved({ humanReview: false })
    await reportFindings(await nextJob(task, 'developer'), task)
    const before = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    const reviewer = await nextJob(task, 'reviewer')
    await runner.call(reviewer.runId, reviewer.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Good.', criteria: verdicts(task, [true, true]) })
    expect(await taskRow(task.id)).toMatchObject({ status: 'human_review' })

    const after = await t.request('GET', '/api/inbox').then(r => r.json()) as Inbox
    expect(after.count).toBe(before.count + 1)
    expect(after.needsYou.find(i => i.id === task.id)).toMatchObject({ type: 'human_review', body: `## Findings\n\n${FINDINGS}`, preview: `## Findings\n\n${FINDINGS}`.slice(0, 200) })
    await runner.next('run.stop', m => m.runId === reviewer.runId)
    const feedback = 'Please compare session locks too.'
    expect((await t.request('POST', `/api/inbox/${task.id}/actions`, { action: 'request_changes', text: feedback })).status).toBe(200)
    expect(await taskRow(task.id)).toMatchObject({ status: 'in_progress' })
    expect((await nextJob(task, 'developer')).prompt).toContain(feedback)
    await pause(project)
  })

  it('keeps plain tasks on the PR path: a branch, a PR, and Ready to merge after review', async () => {
    const { project, task } = await approved({ title: 'Add login', type: 'task', acceptanceCriteria: ['Shows an error on a bad password'] })
    const developer = await nextJob(task, 'developer')
    expect(developer.branch).toMatch(new RegExp(`^corral/${task.ref.toLowerCase()}-`))
    expect(developer.prompt).toContain('"pr_opened"')
    expect(developer.prompt).not.toContain('findings_reported')

    // Findings are only for spikes
    expect(await runner.call(developer.runId, developer.leaseEpoch, 'report_outcome', { outcome: 'findings_reported', note: 'Did the work', summary: 'Here is what I found' }))
      .toMatchObject({ ok: false, error: expect.stringContaining('Only a spike reports findings') })

    t.github.setBranch(project.repository, developer.branch!, 'abc123')
    await attachAll(developer, task)
    expect(await runner.call(developer.runId, developer.leaseEpoch, 'report_outcome', { outcome: 'pr_opened', note: 'Did the work', summary: 'Added login', headSha: 'abc123' }))
      .toMatchObject({ ok: true })
    expect(await taskRow(task.id)).toMatchObject({ status: 'agent_review', prNumber: 1, headSha: 'abc123' })
    await runner.next('run.stop', m => m.runId === developer.runId)

    const reviewer = await nextJob(task, 'reviewer')
    expect(reviewer).toMatchObject({ headSha: 'abc123', branch: developer.branch })
    expect(reviewer.prompt).toContain('git diff')
    expect(reviewer.prompt).not.toContain('Findings under review')
    await runner.call(reviewer.runId, reviewer.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Good.', criteria: verdicts(task, [true]) })
    const row = await taskRow(task.id)
    expect(row).toMatchObject({ status: 'ready_to_merge', mergedAt: null })
    expect((await commentsOf(project, task)).some(c => c.body.startsWith('## Findings'))).toBe(false)
    const transitions = await t.db.select().from(auditLog).where(and(eq(auditLog.taskId, task.id), eq(auditLog.action, 'task.transition')))
    expect(transitions.map(e => (e.detail as { to: string }).to)).toEqual(['ready', 'agent_review', 'ready_to_merge'])
    await pause(project)
  })
})
