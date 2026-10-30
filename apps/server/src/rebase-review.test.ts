import { databaseFixture } from '@corral/db/testing'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Inbox, Project, RunJob, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, expect, it } from 'vitest'
import type { RebaseCheckFailure } from './rebase-review.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

let t: TestApp
let runner: FakeRunner
let project: Project
databaseFixture('postgres', async () => {
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
async function submitted(humanReview = false, options: { epicMode?: 'each_task', checkFailures?: RebaseCheckFailure[], humanCheck?: boolean } = {}) {
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true, requiredChecks: ['lint'] })
  const task = await t.createTask(project.slug, { humanReview, acceptanceCriteria: ['Preserves validation', options.humanCheck ? { text: 'Preserves navigation', checkedByHuman: true } : 'Preserves navigation'] })
  const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'reviewer'))
  const [run] = await t.db.insert(schema.runs).values({ projectId: project.id, taskId: task.id, agentId: agent!.id, role: 'reviewer', state: 'completed', outcome: 'approved', endedAt: new Date() }).returning()
  const criteria = task.acceptanceCriteria.map(c => c.checkedByHuman ? { criterionId: c.id, met: null, note: 'Needs human check' } : { criterionId: c.id, met: true, note: `Earlier proof: ${c.text}` })
  await t.db.insert(schema.reviews).values({ taskId: task.id, runId: run!.id, round: 0, headSha: 'approved-head', verdict: 'approved', summary: 'Feature checked', criteria, author: t.actor })
  await t.db.insert(schema.evidence).values(criteria.map(c => ({ taskId: task.id, runId: run!.id, criterionId: c.criterionId, round: 0, kind: 'note' as const, size: 0, note: c.note })))
  const branch = `corral/${task.ref.toLowerCase()}`
  const [epic] = options.epicMode
    ? await t.db.insert(schema.epics).values({ projectId: project.id, title: `Epic for ${task.ref}`, reviewMode: options.epicMode, createdBy: t.actor }).returning()
    : []
  await t.db.update(schema.tasks).set({ status: 'in_progress', branch, headSha: 'approved-head', approvedHeadSha: 'approved-head', rebaseOnly: true, epicId: epic?.id ?? null }).where(eq(schema.tasks.id, task.id))
  t.github.setBranch(project.repository, branch, 'approved-head')
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: false })
  await t.orchestrator.schedule()
  const dev = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'developer')).job
  await capture(`developer-prompt-${humanReview}.json`, { transport: 'Runner WebSocket assignment from isolated test server', developerAssignment: dev })
  t.github.setBranch(project.repository, branch, 'new-head')
  const submission = { outcome: 'pr_rebased', review: humanReview ? 'trivial' : 'needs_review', conflictedFiles: ['app.ts'], headSha: 'new-head', summary: 'app.ts: retained main validation and task navigation', note: 'app.ts: retained both sides of the conflict' }
  const validation = []
  for (const invalid of [
    { ...submission, review: undefined },
    { ...submission, conflictedFiles: [] },
    { ...submission, conflictedFiles: undefined },
    { ...submission, review: 'easy' },
    { ...submission, conflictedFiles: [' '] }
  ]) {
    const result = await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', invalid)
    const field = invalid.review === undefined || invalid.review === 'easy' ? 'review' : 'conflictedFiles'
    expect(result).toMatchObject({ ok: false, error: expect.stringContaining(field) })
    validation.push({ request: invalid, response: result })
  }
  await capture(`validation-${humanReview}.json`, { transport: 'Runner WebSocket report_outcome; isolated test server, simulated GitHub', validation })
  // Held back so the check's result is there when the review is assigned
  if (options.checkFailures) await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
  const submitted = await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', submission)
  expect(submitted, JSON.stringify(submitted)).toMatchObject({ ok: true })
  if (options.checkFailures) {
    await recordCheckFailures(task.id, options.checkFailures)
    await t.request('PATCH', `/api/projects/${project.slug}`, { paused: false })
  }
  await t.orchestrator.schedule()
  const review = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'reviewer')).job
  await capture(`prompt-${humanReview}.json`, { transport: 'Real runner WebSocket to isolated server; GitHub simulated, no remote writes', submission, reviewerAssignment: review })
  expect(review.prompt).toContain(`Developer review choice: ${submission.review}`)
  expect(review.prompt).toContain('Conflicted files: app.ts')
  const runsResponse = await fetch(`${t.server!.url}/api/runs?taskId=${task.id}`)
  const runHistory = await runsResponse.json()
  expect(runHistory).toEqual(expect.arrayContaining([expect.objectContaining({ id: dev.runId, review: submission.review, conflictedFiles: ['app.ts'] })]))
  const historyResponse = await fetch(`${t.server!.url}/api/projects/${project.slug}/tasks/${task.number}/history`)
  const history = await historyResponse.json()
  expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'run.ended', detail: expect.objectContaining({ runId: dev.runId, review: submission.review, conflictedFiles: ['app.ts'] }) })]))
  await capture(`task-history-${humanReview}.json`, { request: { method: 'GET', url: historyResponse.url }, status: historyResponse.status, body: history })
  await capture(`run-history-${humanReview}.json`, { request: { method: 'GET', url: runsResponse.url }, status: runsResponse.status, body: runHistory })
  expect(review.prompt).toContain('Previously approved head: approved-head. New head: new-head')
  expect(review.prompt).toContain('git range-diff <old-base>..<approved> <new-base>..<new-head>')
  expect(review.prompt).toContain('specific main/base commit')
  expect(review.prompt).toContain('binding docs changed')
  expect(review.prompt).toContain('If the rebase changed something substantial, report outcome "blocked"')
  expect(review.prompt).not.toContain('Judge every acceptance criterion')
  return { project, task, review, criteria }
}
// The server check records its result with the submission
async function recordCheckFailures(taskId: string, checkFailures: RebaseCheckFailure[]) {
  const [entry] = await t.db.select().from(schema.auditLog)
    .where(and(eq(schema.auditLog.taskId, taskId), sql`${schema.auditLog.detail}->>'event' = 'pr_rebased'`))
  await t.db.update(schema.auditLog).set({ detail: { ...entry!.detail as object, checkFailures } }).where(eq(schema.auditLog.id, entry!.id))
}
async function inboxItems() {
  const response = await fetch(`${t.server!.url}/api/inbox`)
  expect(response.status).toBe(200)
  return await response.json() as Inbox
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
it.each([
  { humanReview: false, epicMode: undefined },
  { humanReview: true, epicMode: undefined },
  { humanReview: false, epicMode: 'each_task' as const }
])('carries approval and notes onto the new head and returns to Ready to merge ($humanReview, $epicMode)', async ({ humanReview, epicMode }) => {
  const { task, review, criteria, project } = await submitted(humanReview, epicMode ? { epicMode } : {})
  const result = await reportAndRead(task, review, { outcome: 'approved', summary: 'app.ts conflict resolution holds: both validation and navigation survive.' })
  expect(result.body).toMatchObject({ status: 'ready_to_merge', reviewRounds: 0 })
  expect(result.body.acceptanceCriteria.every(c => c.met === true)).toBe(true)
  expect(result.body.latestReview?.criteria).toEqual(criteria)
  const [approval] = await t.db.select().from(schema.reviews).where(eq(schema.reviews.runId, review.runId))
  expect(approval).toMatchObject({ headSha: 'new-head', verdict: 'approved', criteria, summary: expect.stringContaining('carried over a reviewed rebase') })
  const notes = await t.db.select().from(schema.comments).where(eq(schema.comments.taskId, task.id))
  const comment = notes.find(c => c.body.startsWith('Rebase review approved:'))!.body
  expect(comment).toContain('app.ts')
  expect(comment).not.toContain('Earlier proof')
  const inbox = await inboxItems()
  expect(inbox.needsYou.filter(item => item.type === 'human_review')).toEqual([])
  expect(inbox.activity.filter(item => item.taskId === task.id).map(item => item.type)).not.toContain('human_review')
  await capture(`approved-${epicMode ?? humanReview}.json`, { ...result, persistedApproval: approval, taskComment: comment, inbox })
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
})
it('sends a flagged task back to Human review with its human check still open', async () => {
  const { task, review, criteria, project } = await submitted(false, { humanCheck: true })
  const result = await reportAndRead(task, review, { outcome: 'approved', summary: 'app.ts conflict resolution holds.' })
  expect(result.body).toMatchObject({ status: 'human_review', humanReview: false })
  expect(result.body.latestReview?.criteria).toEqual(criteria)
  expect(result.body.acceptanceCriteria.map(c => c.met)).toEqual([true, null])
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
})
it('tells the reviewer which server check condition failed and on which files', async () => {
  const { task, review, project } = await submitted(false, { checkFailures: [
    { condition: 'changes_outside_conflicts', files: ['billing.ts'] },
    { condition: 'project_docs_changed', files: ['docs/decisions.md'] }
  ] })
  expect(review.prompt).toContain('## Server check failed')
  expect(review.prompt).toContain('not in the developer\'s conflicted-file list: `billing.ts`')
  expect(review.prompt).toContain('These project docs changed on the base since approval: `docs/decisions.md`')
  await capture('prompt-check-failed.json', { taskRef: task.ref, reviewerAssignment: review })
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
})
it('returns a rebase that landed on the approved head to Ready to merge, not Human review', async () => {
  const task = await t.createTask(project.slug, { humanReview: true, acceptanceCriteria: ['Preserves validation'] })
  const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'reviewer'))
  const [run] = await t.db.insert(schema.runs).values({ projectId: project.id, taskId: task.id, agentId: agent!.id, role: 'reviewer', state: 'completed', outcome: 'approved', endedAt: new Date() }).returning()
  await t.db.insert(schema.reviews).values({ taskId: task.id, runId: run!.id, round: 0, headSha: 'same-head', verdict: 'approved', summary: 'Checked', criteria: [], author: t.actor })
  await t.db.update(schema.tasks).set({ status: 'agent_review', headSha: 'same-head', approvedHeadSha: 'same-head', rebaseOnly: true }).where(eq(schema.tasks.id, task.id))
  await t.orchestrator.merges.tick()
  const [row] = await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
  expect(row).toMatchObject({ status: 'ready_to_merge', rebaseOnly: false })
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
