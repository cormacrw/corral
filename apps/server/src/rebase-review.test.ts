import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Project, RunJob, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

let t: TestApp
let runner: FakeRunner
let project: Project
beforeAll(async () => {
  t = await createTestApp('postgres', { listen: true })
  await t.db.update(schema.agents).set({ concurrency: 20, wakeIntervalSeconds: null })
  runner = await FakeRunner.connect(t.server!.url)
  project = await t.createProject({ repository: 'cormacrw/test-app', defaultBranch: 'main' })
})
afterAll(async () => {
  runner?.close()
  await t?.close()
})
async function capture(name: string, data: unknown) {
  if (process.env.CORRAL_REBASE_EVIDENCE_DIR) await writeFile(join(process.env.CORRAL_REBASE_EVIDENCE_DIR, name), JSON.stringify(data, null, 2))
}
async function submitted(humanReview = false) {
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true, requiredChecks: ['lint'] })
  const task = await t.createTask(project.slug, { humanReview, acceptanceCriteria: ['Preserves validation', 'Preserves navigation'] })
  const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'reviewer'))
  const [run] = await t.db.insert(schema.runs).values({ projectId: project.id, taskId: task.id, agentId: agent!.id, role: 'reviewer', state: 'completed', outcome: 'approved' }).returning()
  const criteria = task.acceptanceCriteria.map(c => ({ criterionId: c.id, met: true, note: `Earlier proof: ${c.text}` }))
  await t.db.insert(schema.reviews).values({ taskId: task.id, runId: run!.id, round: 0, headSha: 'approved-head', verdict: 'approved', summary: 'Feature checked', criteria, author: t.actor })
  await t.db.insert(schema.evidence).values(criteria.map(c => ({ taskId: task.id, runId: run!.id, criterionId: c.criterionId, round: 0, kind: 'note' as const, size: 0, note: c.note })))
  const branch = `corral/${task.ref.toLowerCase()}`
  await t.db.update(schema.tasks).set({ status: 'in_progress', branch, headSha: 'approved-head', approvedHeadSha: 'approved-head', rebaseOnly: true }).where(eq(schema.tasks.id, task.id))
  t.github.setBranch(project.repository, branch, 'approved-head')
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: false })
  await t.orchestrator.schedule()
  const dev = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'developer')).job
  t.github.setBranch(project.repository, branch, 'new-head')
  const submission = { outcome: 'pr_rebased', headSha: 'new-head', summary: 'app.ts: retained main validation and task navigation', note: 'app.ts: retained both sides of the conflict' }
  const submitted = await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', submission)
  expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true })
  await t.orchestrator.schedule()
  const review = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'reviewer')).job
  await capture(`prompt-${humanReview}.json`, { transport: 'Real runner WebSocket to isolated server; GitHub simulated, no remote writes', submission, reviewerAssignment: review })
  expect(review.prompt).toContain('Previously approved head: approved-head. New head: new-head')
  expect(review.prompt).toContain('git range-diff <old-base>..<approved> <new-base>..<new-head>')
  expect(review.prompt).toContain('specific main/base commit')
  expect(review.prompt).toContain('binding docs changed')
  expect(review.prompt).not.toContain('Judge every acceptance criterion')
  return { project, task, review, criteria }
}
async function reportAndRead(task: Task, job: RunJob, report: Record<string, unknown>) {
  const response = await runner.call(job.runId, job.leaseEpoch, 'report_outcome', report)
  expect(response).toMatchObject({ ok: true })
  const [project] = await t.db.select().from(schema.projects).where(eq(schema.projects.id, task.projectId))
  const url = `${t.server!.url}/api/projects/${project!.slug}/tasks/${task.number}`
  const http = await fetch(url)
  expect(http.status).toBe(200)
  const body = await http.json() as Task
  const commentsUrl = `${url}/comments`
  const commentsResponse = await fetch(commentsUrl)
  const taskComments = await commentsResponse.json()
  return { commentsRequest: { method: 'GET', url: commentsUrl }, commentsStatus: commentsResponse.status, taskComments, report, response, request: { method: 'GET', url }, status: http.status, body }
}
it.each([false, true])('carries approval and notes onto the new head (humanReview=%s)', async (humanReview) => {
  const { task, review, criteria, project } = await submitted(humanReview)
  const result = await reportAndRead(task, review, { outcome: 'approved', summary: 'app.ts conflict resolution holds: both validation and navigation survive.' })
  expect(result.body).toMatchObject({ status: humanReview ? 'human_review' : 'ready_to_merge', reviewRounds: 0 })
  expect(result.body.acceptanceCriteria.every(c => c.met === true)).toBe(true)
  expect(result.body.latestReview?.criteria).toEqual(criteria)
  const [approval] = await t.db.select().from(schema.reviews).where(eq(schema.reviews.runId, review.runId))
  expect(approval).toMatchObject({ headSha: 'new-head', verdict: 'approved', criteria, summary: expect.stringContaining('carried over a reviewed rebase') })
  const notes = await t.db.select().from(schema.comments).where(eq(schema.comments.taskId, task.id))
  const comment = notes.find(c => c.body.startsWith('Rebase review approved:'))!.body
  expect(comment).toContain('app.ts')
  expect(comment).not.toContain('Earlier proof')
  await capture(`approved-${humanReview}.json`, { ...result, persistedApproval: approval, taskComment: comment })
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
})
it('counts changes requested as a normal revision and keeps its comment short', async () => {
  const { task, review, criteria, project } = await submitted()
  const result = await reportAndRead(task, review, { outcome: 'changes_requested', summary: 'app.ts resolution drops validation; restore main validation.', criteria: criteria.map(c => ({ ...c, met: false })) })
  expect(result.body).toMatchObject({ status: 'in_progress', reviewRounds: 1 })
  const [row] = await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
  expect(row!.rebaseOnly).toBe(false)
  const notes = await t.db.select().from(schema.comments).where(eq(schema.comments.taskId, task.id))
  const comment = notes.find(c => c.body.startsWith('Rebase review changes requested:'))!.body
  expect(comment).not.toContain('Earlier proof')
  await capture('changes-requested.json', { ...result, taskComment: comment })
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
})
it('blocks for a changed binding decision without consuming a round', async () => {
  const { task, review, project } = await submitted()
  const reason = 'app.ts conflicts with docs/decisions.md: main now forbids password login, invalidating the validation criterion. Human decision needed.'
  const result = await reportAndRead(task, review, { outcome: 'blocked', summary: reason })
  expect(result.body).toMatchObject({ status: 'blocked', statusReason: reason, reviewRounds: 0 })
  const notes = await t.db.select().from(schema.comments).where(eq(schema.comments.taskId, task.id))
  expect(notes.some(c => c.body === `Rebase review blocked: ${reason}`)).toBe(true)
  await capture('blocked.json', result)
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
})
