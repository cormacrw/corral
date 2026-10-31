import { TASK_INTEGRATION_PROTOCOL, type RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

let t: TestApp
let runner: FakeRunner
beforeAll(async () => {
  t = await createTestApp('pglite', { listen: true })
  await t.db.update(schema.agents).set({ concurrency: 50, wakeIntervalSeconds: null })
  runner = await FakeRunner.connect(t.server!.url, [], 'r1', { taskIntegrationProtocols: [TASK_INTEGRATION_PROTOCOL] })
})
afterAll(async () => {
  runner?.close()
  await t?.close()
})
beforeEach(() => {
  t.github.calls.length = 0
})

type Created = Awaited<ReturnType<TestApp['createTask']>>

async function epicTask(mode: 'epic' | 'each_task' | 'direct' = 'epic', input: Record<string, unknown> = {}) {
  const project = await t.createProject()
  const [epic] = await t.db.insert(schema.epics).values({ projectId: project.id, createdBy: t.actor, title: 'Feature', reviewMode: mode }).returning()
  const task = await t.createTask(project.slug, { epicId: epic!.id, humanReview: false, ...input })
  expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })).status).toBe(200)
  return { project, epic: epic!, task }
}

async function assigned(task: Created, role: RunJob['role'], s = runner) {
  await t.orchestrator.schedule()
  return (await s.next('run.assign', m => 'taskId' in m.job && m.job.taskId === task.id && m.job.role === role)).job as RunJob & { branch: string, baseBranch: string, integrationProtocol?: number }
}

async function submit(job: RunJob, repository: string, task: Created, head: string, base = 'epic-tip', outcome = 'commit_submitted', s = runner) {
  t.github.setBranch(repository, (job as { branch: string }).branch, head)
  for (const c of task.acceptanceCriteria) await s.call(job.runId, job.leaseEpoch, 'attach_evidence', { criterionId: c.id, kind: 'note', note: `Evidence for ${head}` })
  return s.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome, note: 'Implemented it', summary: 'The change', headSha: head, baseSha: base })
}

const verdict = (task: Created, outcome: string, headSha: string) => ({
  outcome, summary: 'Checked', headSha, criteria: task.acceptanceCriteria.map(c => ({ criterionId: c.id, met: outcome === 'approved', note: 'Checked' }))
})

async function row(task: Created) {
  return (await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)))[0]!
}

it('submits an epic task as a commit, without a PR, and starts agent review of it', async () => {
  const { project, task } = await epicTask()
  const dev = await assigned(task, 'developer')
  expect(dev.integrationProtocol).toBe(1)
  expect(dev.prompt).toContain('"commit_submitted"')
  expect(dev.prompt).toContain('only Corral writes to the shared epic branch')
  expect(dev.prompt).not.toContain('opens the PR')
  expect(await submit(dev, project.repository, task, 'head-1')).toMatchObject({ ok: true, result: { commit: 'head-1', message: expect.stringContaining('Commit head-1') } })
  expect(t.github.calls.filter(c => c.method === 'openPullRequest' || c.method === 'updatePullRequest')).toEqual([])
  expect([...t.github.pulls.values()].some(p => p.head === dev.branch)).toBe(false)
  expect(await row(task)).toMatchObject({ status: 'agent_review', prNumber: null, headSha: 'head-1', branch: dev.branch, integrationProtocol: 1 })
  expect(await t.db.select().from(schema.taskSubmissions).where(eq(schema.taskSubmissions.taskId, task.id))).toMatchObject([{ sequence: 1, submittedHeadSha: 'head-1', baseSha: 'epic-tip', branch: dev.branch, targetBranch: dev.baseBranch }])
  expect((await assigned(task, 'reviewer')).headSha).toBe('head-1')
})

it('rejects a PR outcome on this path, and a submission with no commits of its own', async () => {
  const { project, task } = await epicTask()
  const dev = await assigned(task, 'developer')
  expect(await submit(dev, project.repository, task, 'head-1', 'epic-tip', 'pr_opened')).toMatchObject({ ok: false, error: expect.stringContaining('report commit_submitted') })
  expect(await submit(dev, project.repository, task, 'epic-tip', 'epic-tip')).toMatchObject({ ok: false, error: expect.stringContaining('no commit to submit') })
  expect(await row(task)).toMatchObject({ status: 'in_progress', headSha: null })
})

it('gives the reviewer the commit, epic base, criteria and evidence, and binds the verdict to that commit', async () => {
  const { project, task } = await epicTask()
  await t.db.update(schema.projects).set({ requiredChecks: ['ci'] }).where(eq(schema.projects.id, project.id))
  const dev = await assigned(task, 'developer')
  await submit(dev, project.repository, task, 'head-1')
  const review = await assigned(task, 'reviewer')
  expect(review.prompt).toContain(`submitted commit head-1 on task branch \`${dev.branch}\``)
  expect(review.prompt).toContain(`recorded base is commit epic-tip of epic branch \`${dev.baseBranch}\``)
  expect(review.prompt).toContain('git diff epic-tip...HEAD')
  expect(review.prompt).toContain(task.acceptanceCriteria[0]!.id)
  expect(review.prompt).toContain('Evidence for head-1')
  expect(review.prompt).toContain('This project has required CI checks: `ci`')
  expect(review.prompt).toContain('the epic PR\'s CI is the merge gate')

  expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', verdict(task, 'approved', 'something-else'))).toMatchObject({ ok: false, error: expect.stringContaining('the submitted commit is head-1') })
  expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { ...verdict(task, 'approved', ''), headSha: undefined })).toMatchObject({ ok: false, error: expect.stringContaining('Not recorded') })
  t.github.setBranch(project.repository, dev.branch, 'pushed-later')
  expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', verdict(task, 'approved', 'head-1'))).toMatchObject({ ok: false, error: expect.stringContaining('is at pushed-later') })
  expect(await t.db.select().from(schema.reviews).where(eq(schema.reviews.taskId, task.id))).toEqual([])

  t.github.setBranch(project.repository, dev.branch, 'head-1')
  expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', verdict(task, 'approved', 'head-1'))).toMatchObject({ ok: true, result: { message: expect.stringContaining('integrates it into the epic branch') } })
  expect(await t.db.select().from(schema.taskSubmissions).where(eq(schema.taskSubmissions.taskId, task.id))).toMatchObject([{ agentApprovedHeadSha: 'head-1', integratedCommitSha: null }])
  // Approval isn't completion: the task waits and no GitHub merge is attempted
  await t.orchestrator.merges.tick()
  expect(await row(task)).toMatchObject({ status: 'ready_to_merge', prNumber: null })
  expect(t.github.calls.some(c => c.method === 'merge')).toBe(false)
})

it('binds an approved rebase review to the new commit and carries the approval to its submission', async () => {
  const { project, task } = await epicTask()
  const dev = await assigned(task, 'developer')
  await submit(dev, project.repository, task, 'head-1')
  const review = await assigned(task, 'reviewer')
  await runner.call(review.runId, review.leaseEpoch, 'report_outcome', verdict(task, 'approved', 'head-1'))
  await t.db.update(schema.tasks).set({ status: 'in_progress', rebaseOnly: true, approvedHeadSha: 'head-1' }).where(eq(schema.tasks.id, task.id))

  const rebase = await assigned(task, 'developer')
  expect(rebase.prompt).toContain('Report `commit_submitted`')
  await submit(rebase, project.repository, task, 'head-2')
  const check = await assigned(task, 'reviewer')
  expect(check.prompt).not.toContain('Developer review choice')
  const report = { outcome: 'approved', summary: 'The resolution holds', headSha: 'head-2' }
  expect(await runner.call(check.runId, check.leaseEpoch, 'report_outcome', { ...report, headSha: 'head-1' })).toMatchObject({ ok: false, error: expect.stringContaining('the submitted commit is head-2') })
  t.github.setBranch(project.repository, dev.branch, 'pushed-later')
  expect(await runner.call(check.runId, check.leaseEpoch, 'report_outcome', report)).toMatchObject({ ok: false, error: expect.stringContaining('is at pushed-later') })

  t.github.setBranch(project.repository, dev.branch, 'head-2')
  expect(await runner.call(check.runId, check.leaseEpoch, 'report_outcome', report)).toMatchObject({ ok: true })
  expect(await row(task)).toMatchObject({ status: 'ready_to_merge', headSha: 'head-2' })
  expect(await t.db.select().from(schema.taskSubmissions).where(eq(schema.taskSubmissions.taskId, task.id)).orderBy(schema.taskSubmissions.sequence)).toMatchObject([{ agentApprovedHeadSha: 'head-1' }, { agentApprovedHeadSha: 'head-2' }])
})

it('leaves a human check open through a rebase review, for the epic approval', async () => {
  const { project, task } = await epicTask('epic', { acceptanceCriteria: ['It works', { text: 'On a real iPhone', checkedByHuman: true }] })
  const dev = await assigned(task, 'developer')
  await submit(dev, project.repository, task, 'head-1')
  const review = await assigned(task, 'reviewer')
  await runner.call(review.runId, review.leaseEpoch, 'report_outcome', verdict(task, 'approved', 'head-1'))
  expect(await row(task)).toMatchObject({ status: 'ready_to_merge' })
  await t.db.update(schema.tasks).set({ status: 'in_progress', rebaseOnly: true, approvedHeadSha: 'head-1' }).where(eq(schema.tasks.id, task.id))

  await submit(await assigned(task, 'developer'), project.repository, task, 'head-2')
  const check = await assigned(task, 'reviewer')
  expect(await runner.call(check.runId, check.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'The resolution holds', headSha: 'head-2' })).toMatchObject({ ok: true })
  expect(await row(task)).toMatchObject({ status: 'ready_to_merge', rebaseOnly: false, headSha: 'head-2' })
})

it('returns requested changes to the same branch and keeps the discussion, evidence and earlier submission', async () => {
  const { project, task } = await epicTask()
  const dev = await assigned(task, 'developer')
  await submit(dev, project.repository, task, 'head-1')
  const review = await assigned(task, 'reviewer')
  await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { ...verdict(task, 'changes_requested', 'head-1'), summary: 'Handle the empty list' })
  const revision = await assigned(task, 'developer')
  expect(revision.branch).toBe(dev.branch)
  expect(revision.headSha).toBe('head-1')
  expect(revision.prompt).toContain('Handle the empty list')
  expect(revision.prompt).toContain('"commit_submitted"')
  expect(await submit(revision, project.repository, task, 'head-2', 'epic-tip-2')).toMatchObject({ ok: true })

  const second = await assigned(task, 'reviewer')
  expect(second.prompt).toContain('Submission 1: commit head-1 on base epic-tip')
  expect(second.prompt).toContain('submitted commit head-2')
  expect(second.prompt).toContain('Handle the empty list')
  expect(await t.db.select().from(schema.taskSubmissions).where(eq(schema.taskSubmissions.taskId, task.id)).orderBy(schema.taskSubmissions.sequence)).toMatchObject([{ submittedHeadSha: 'head-1', baseSha: 'epic-tip' }, { submittedHeadSha: 'head-2', baseSha: 'epic-tip-2' }])
  const view = await runner.call(second.runId, second.leaseEpoch, 'get_task', {}) as unknown as { result: { evidence: { round: number, note: string }[], comments: { body: string }[], submissions: { headSha: string }[] } }
  expect(view.result.evidence.map(e => [e.round, e.note])).toEqual(expect.arrayContaining([[0, 'Evidence for head-1'], [1, 'Evidence for head-2']]))
  expect(view.result.comments.some(c => c.body.includes('Handle the empty list'))).toBe(true)
  expect(view.result.submissions.map(s => s.headSha)).toEqual(['head-1', 'head-2'])
  expect(await t.db.select().from(schema.reviews).where(eq(schema.reviews.taskId, task.id))).toMatchObject([{ headSha: 'head-1', verdict: 'changes_requested' }])
})

it('continues a stopped run on the same branch and still submits a commit', async () => {
  const { project, task } = await epicTask()
  const dev = await assigned(task, 'developer')
  runner.send({ type: 'run.ended', runId: dev.runId, leaseEpoch: dev.leaseEpoch, exit: { kind: 'exited', code: 1 }, headSha: 'wip-1', wipSha: 'wip-1' })
  const next = await assigned(task, 'developer')
  expect(next.branch).toBe(dev.branch)
  expect(next.continueFrom).toBe('wip-1')
  expect(next.prompt).toContain('WIP commit `wip-1`')
  expect(next.prompt).toContain('"commit_submitted"')
  expect(await submit(next, project.repository, task, 'head-1')).toMatchObject({ ok: true })
  expect(await row(task)).toMatchObject({ status: 'agent_review', prNumber: null })
})

it('keeps a selected task on its epic', async () => {
  const { project, task } = await epicTask()
  await assigned(task, 'developer')
  const patched = await t.request('PATCH', `/api/projects/${project.slug}/tasks/${task.number}`, { epicId: null })
  expect(patched.status).toBe(409)
  expect(await row(task)).toMatchObject({ integrationProtocol: 1 })
})

it.each([
  ['standalone', async () => {
    const project = await t.createProject()
    const task = await t.createTask(project.slug, { humanReview: false })
    await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
    return { project, task }
  }],
  ['direct', () => epicTask('direct')],
  ['each_task', () => epicTask('each_task')]
])('opens and updates a PR for a %s task, even on a supporting runner', async (_, setup) => {
  const { project, task } = await setup()
  const dev = await assigned(task, 'developer')
  expect(dev.integrationProtocol).toBe(0)
  expect(dev.prompt).toContain('"pr_opened"')
  expect(await submit(dev, project.repository, task, 'head-1', 'unused', 'commit_submitted')).toMatchObject({ ok: false, error: expect.stringContaining('pr_opened or pr_updated') })
  expect(await submit(dev, project.repository, task, 'head-1', 'unused', 'pr_opened')).toMatchObject({ ok: true, result: { pr: expect.any(String) } })
  const review = await assigned(task, 'reviewer')
  expect(review.prompt).toContain(`You are checking commit head-1 on branch \`${dev.branch}\``)
  await runner.call(review.runId, review.leaseEpoch, 'report_outcome', verdict(task, 'changes_requested', 'head-1'))
  const revision = await assigned(task, 'developer')
  expect(await submit(revision, project.repository, task, 'head-2', 'unused', 'pr_updated')).toMatchObject({ ok: true })
  expect(t.github.calls.filter(c => c.method === 'openPullRequest')).toHaveLength(1)
  expect(t.github.calls.filter(c => c.method === 'updatePullRequest')).toHaveLength(1)
  expect(await t.db.select().from(schema.taskSubmissions).where(eq(schema.taskSubmissions.taskId, task.id))).toEqual([])
})

it.each(['spike', 'design'] as const)('leaves a %s with its own deliverable', async (type) => {
  const { task } = await epicTask('epic', { type })
  const dev = await assigned(task, type === 'design' ? 'designer' : 'developer')
  expect(dev.integrationProtocol).toBe(0)
  expect(dev.prompt).toContain(type === 'design' ? 'design_submitted' : 'findings_reported')
  expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'commit_submitted', note: 'Wrong', summary: 'Wrong', headSha: 'h', baseSha: 'b' })).toMatchObject({ ok: false, error: expect.stringContaining(type === 'design' ? 'design_submitted' : 'findings_reported') })
})

it('keeps an epic task on a legacy runner, or with a PR already on its branch, on the PR path', async () => {
  const legacy = await FakeRunner.connect(t.server!.url, [], 'legacy', {})
  try {
    const fresh = await epicTask()
    await t.db.update(schema.agents).set({ wakeIntervalSeconds: null })
    runner.close()
    const job = await assigned(fresh.task, 'developer', legacy)
    expect(job.integrationProtocol).toBe(0)
    expect(job.prompt).toContain('"pr_opened"')
    runner = await FakeRunner.connect(t.server!.url, [], 'r1', { taskIntegrationProtocols: [TASK_INTEGRATION_PROTOCOL] })
    const { project, task } = await epicTask()
    await t.db.update(schema.tasks).set({ branch: 'corral/recovered' }).where(eq(schema.tasks.id, task.id))
    t.github.setBranch(project.repository, 'corral/recovered', 'head-0')
    await t.github.openPullRequest(project.repository, { head: 'corral/recovered', base: 'main', title: 'Recovered', body: '' })
    await t.orchestrator.schedule()
    const message = await Promise.race([runner.next('run.assign', m => 'taskId' in m.job && m.job.taskId === task.id), legacy.next('run.assign', m => 'taskId' in m.job && m.job.taskId === task.id)])
    expect(message.job).toMatchObject({ integrationProtocol: 0 })
    expect(message.job.prompt).toContain('"pr_opened"')
  } finally {
    legacy.close()
  }
})
