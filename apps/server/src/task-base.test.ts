import { databaseFixture } from '@corral/db/testing'
import type { Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, expect, it } from 'vitest'
import { GitHubError } from './github.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './fake-runner.ts'

let t: TestApp
let runner: FakeRunner
databaseFixture('postgres', async () => {
  t = await createTestApp('postgres', { listen: true })
  await t.db.update(schema.agents).set({ concurrency: 50, wakeIntervalSeconds: null })
  runner = await FakeRunner.connect(t.server!.url)
})
afterAll(async () => {
  runner?.close()
  await t?.close()
})

// The runner's git for a PR-free subtask: its approved commit lands on the
// task's branch as `merge-sha`, or conflicts with it
function integrates(result: 'integrated' | 'conflict' = 'integrated') {
  const fallback = runner.onJob
  runner.onJob = (job) => {
    if (job.kind !== 'integration_prepare') return fallback(job)
    if (result === 'conflict') return { kind: 'integration_prepare', status: 'conflict', targetSha: job.expectedTargetSha, commitSha: null, files: ['api.ts'] }
    t.github.setBranch(job.repository, job.targetBranch, 'merge-sha')
    return { kind: 'integration_prepare', status: 'integrated', targetSha: job.expectedTargetSha, commitSha: 'merge-sha', files: [] }
  }
  return () => {
    runner.onJob = fallback
  }
}

it('uses the epic base throughout claim, review, merge and dependent claims on develop', async () => {
  const project = await t.createProject({ defaultBranch: 'develop' })
  t.github.setBranch(project.repository, 'develop', 'target-tip')
  const [epic] = await t.db.insert(schema.epics).values({ projectId: project.id, createdBy: t.actor, title: 'Feature', reviewMode: 'epic' }).returning()
  const first = await t.createTask(project.slug, { epicId: epic!.id, humanReview: false })
  const second = await t.createTask(project.slug, { epicId: epic!.id, dependsOn: [first.number], humanReview: false })
  for (const task of [first, second]) expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })).status).toBe(200)
  await t.orchestrator.scheduler.schedule()
  const dev = (await runner.next('run.assign', m => m.job.taskId === first.id)).job
  const [saved] = await t.db.select().from(schema.epics).where(eq(schema.epics.id, epic!.id))
  expect(dev.baseBranch).toBe(saved!.branch)
  expect(dev.defaultBranch).toBe('develop')
  expect((await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, second.id)))[0]).toMatchObject({ leaseRunId: null })
  expect(await t.github.branchHead(project.repository, dev.baseBranch!)).toBe('target-tip')
  expect(dev.prompt).toContain(dev.baseBranch!)
  t.github.setBranch(project.repository, dev.branch!, 'task-head')
  for (const c of first.acceptanceCriteria) await runner.call(dev.runId, dev.leaseEpoch, 'attach_evidence', { criterionId: c.id, kind: 'note', note: 'Backend change' })
  expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'commit_submitted', note: 'Implemented the feature', summary: 'Feature', headSha: 'task-head', baseSha: 'target-tip' })).toMatchObject({ ok: true })
  expect([...t.github.pulls.values()].some(p => p.head === dev.branch)).toBe(false)
  await t.orchestrator.scheduler.schedule()
  const review = (await runner.next('run.assign', m => m.job.taskId === first.id && m.job.role === 'reviewer')).job
  expect(review.prompt).toContain(dev.baseBranch!)
  expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Approved', headSha: 'task-head', criteria: first.acceptanceCriteria.map(c => ({ criterionId: c.id, met: true, note: 'Checked' })) })).toMatchObject({ ok: true })
  const restore = integrates()
  try {
    await t.mergePass()
  } finally {
    restore()
  }
  expect(await t.github.branchHead(project.repository, 'develop')).toBe('target-tip')
  expect(await t.github.branchHead(project.repository, dev.baseBranch!)).toBe('merge-sha')
  await t.orchestrator.scheduler.schedule()
  const next = (await runner.next('run.assign', m => m.job.taskId === second.id)).job
  expect(next.baseBranch).toBe(dev.baseBranch)
  expect(await t.github.branchHead(project.repository, next.baseBranch!)).toBe('merge-sha')
  // The final task's normal submit/review/merge automatically opens the
  // epic PR; no human action or separate "open epic" endpoint is involved.
  t.github.setBranch(project.repository, next.branch!, 'second-head')
  for (const c of second.acceptanceCriteria) await runner.call(next.runId, next.leaseEpoch, 'attach_evidence', { criterionId: c.id, kind: 'note', note: 'Second backend change' })
  expect(await runner.call(next.runId, next.leaseEpoch, 'report_outcome', { outcome: 'commit_submitted', note: 'Implemented the feature', summary: 'Second feature', headSha: 'second-head', baseSha: 'merge-sha' })).toMatchObject({ ok: true })
  await t.orchestrator.scheduler.schedule()
  const secondReview = (await runner.next('run.assign', m => m.job.taskId === second.id && m.job.role === 'reviewer')).job
  expect(await runner.call(secondReview.runId, secondReview.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Approved', headSha: 'second-head', criteria: second.acceptanceCriteria.map(c => ({ criterionId: c.id, met: true, note: 'Checked' })) })).toMatchObject({ ok: true })
  const restoreSecond = integrates()
  try {
    await t.orchestrator.tick()
  } finally {
    restoreSecond()
  }
  const epicPr = [...t.github.pulls.values()].find(p => p.head === saved!.branch)!
  expect(epicPr).toMatchObject({ head: saved!.branch, base: 'develop' })
  expect(epicPr.body).toContain(first.ref)
  expect(epicPr.body).toContain(second.ref)
  const integration = (await runner.next('run.assign', m => m.job.epicId === epic!.id)).job
  expect(integration.headSha).toBe(epicPr.headSha)
  expect(await runner.call(integration.runId, integration.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'The API and dependent work integrate correctly.' })).toMatchObject({ ok: true })
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
})

it.each(['epic', 'direct', null] as const)('routes review and conflicts correctly for %s', async (mode) => {
  const project = await t.createProject({ defaultBranch: 'develop' })
  t.github.setBranch(project.repository, 'develop', 'target-tip')
  const [epic] = mode ? await t.db.insert(schema.epics).values({ projectId: project.id, createdBy: t.actor, title: 'Review', reviewMode: mode }).returning() : []
  const task = await t.createTask(project.slug, { epicId: epic?.id ?? null, humanReview: false })
  await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
  await t.orchestrator.scheduler.schedule()
  const dev = (await runner.next('run.assign', m => m.job.taskId === task.id)).job
  t.github.setBranch(project.repository, dev.branch!, `head-${task.id}`)
  for (const c of task.acceptanceCriteria) await runner.call(dev.runId, dev.leaseEpoch, 'attach_evidence', { criterionId: c.id, kind: 'note', note: 'Backend change' })
  // A subtask in `epic` mode submits a commit; the others open a PR
  const submitted = mode === 'epic'
    ? { outcome: 'commit_submitted', headSha: `head-${task.id}`, baseSha: 'target-tip' }
    : { outcome: 'pr_opened', headSha: `head-${task.id}` }
  expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { ...submitted, note: 'Implemented the feature', summary: 'Done' })).toMatchObject({ ok: true })
  await t.orchestrator.scheduler.schedule()
  const review = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'reviewer')).job
  expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Approved', headSha: `head-${task.id}`, criteria: task.acceptanceCriteria.map(c => ({ criterionId: c.id, met: true, note: '' })) })).toMatchObject({ ok: true })
  const get = async () => (await t.request('GET', `/api/projects/${project.slug}/tasks/${task.number}`)).json() as Promise<Task>
  expect((await get()).status).toBe('ready_to_merge')
  const pr = [...t.github.pulls.values()].find(p => p.head === dev.branch)
  if (mode === 'epic') expect(pr).toBeUndefined()
  else expect(pr!.base).toBe('develop')
  if (mode === 'epic') {
    // Its commit conflicts with the task's branch
    const restore = integrates('conflict')
    try {
      await t.mergePass()
    } finally {
      restore()
    }
    expect((await get()).status).toBe('in_progress')
    const notes = await t.db.select().from(schema.comments).where(eq(schema.comments.taskId, task.id))
    expect(notes.at(-1)!.body).toContain(dev.baseBranch!)
  } else {
    await t.mergePass()
    expect((await get()).status).toBe('merged')
    expect(await t.github.branchHead(project.repository, 'develop')).toBe('merge-sha')
  }
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
})

it('interrupts the run, counting nothing, when GitHub gives no real answer about the epic branch, and waits before retrying', async () => {
  const project = await t.createProject({ defaultBranch: 'develop' })
  t.github.setBranch(project.repository, 'develop', 'target-tip')
  const [epic] = await t.db.insert(schema.epics).values({ projectId: project.id, createdBy: t.actor, title: 'Blip', reviewMode: 'epic' }).returning()
  const task = await t.createTask(project.slug, { epicId: epic!.id })
  const createBranch = t.github.createBranch
  t.github.createBranch = () => Promise.reject(new GitHubError(502, 'Bad gateway'))
  await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
  await t.orchestrator.scheduler.schedule()
  t.github.createBranch = createBranch
  await t.orchestrator.scheduler.schedule()
  const runs = await t.db.select().from(schema.runs).where(eq(schema.runs.taskId, task.id))
  expect(runs).toMatchObject([{ state: 'interrupted', outcome: null }])
  expect((await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)))[0]).toMatchObject({ leaseRunId: null, failedRuns: 0 })

  t.clock.now = new Date(t.clock.now.getTime() + 61_000)
  await t.orchestrator.scheduler.schedule()
  await runner.next('run.assign', m => m.job.taskId === task.id)
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
})

it('fails the run with the cause when the epic branch cannot be created, and keeps scheduling', async () => {
  const project = await t.createProject({ defaultBranch: 'develop' })
  t.github.setBranch(project.repository, 'develop', 'target-tip')
  const [epic] = await t.db.insert(schema.epics).values({ projectId: project.id, createdBy: t.actor, title: 'Broken', reviewMode: 'epic' }).returning()
  const epicTask = await t.createTask(project.slug, { epicId: epic!.id, priority: 'urgent' })
  const plain = await t.createTask(project.slug, {})
  const createBranch = t.github.createBranch
  t.github.createBranch = () => Promise.reject(new GitHubError(403, 'GitHub said no'))
  try {
    for (const task of [epicTask, plain]) await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })
    await t.orchestrator.scheduler.schedule()
    await runner.next('run.assign', m => m.job.taskId === plain.id)
  } finally {
    t.github.createBranch = createBranch
  }
  // Each scheduling pass tries the task once; approvals start passes of their own
  const failed = await t.db.select().from(schema.runs).where(eq(schema.runs.taskId, epicTask.id))
  expect(failed.length).toBeGreaterThan(0)
  for (const run of failed) expect(run).toMatchObject({ state: 'failed', outcome: 'failed', error: expect.stringContaining('GitHub said no') })
  const [row] = await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, epicTask.id))
  expect(row).toMatchObject({ leaseRunId: null, failedRuns: failed.length })
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
})
