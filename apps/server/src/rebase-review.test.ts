import { databaseFixture } from '@corral/db/testing'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { Inbox, Project, RunJob, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { and, eq, sql } from 'drizzle-orm'
import { afterAll, expect, it } from 'vitest'
import type { ChangedFile } from './github.ts'
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
async function rebaseRound(humanReview: boolean, options: { epicMode?: 'each_task', humanCheck?: boolean }) {
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true, requiredChecks: ['lint'] })
  const task = await t.createTask(project.slug, { humanReview, acceptanceCriteria: ['Preserves validation', options.humanCheck ? { text: 'Preserves navigation', checkedByHuman: true } : 'Preserves navigation'] })
  const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'reviewer'))
  const [run] = await t.db.insert(schema.runs).values({ projectId: project.id, taskId: task.id, agentId: agent!.id, role: 'reviewer', state: 'completed', outcome: 'approved', endedAt: new Date() }).returning()
  const criteria = task.acceptanceCriteria.map(c => c.checkedByHuman ? { criterionId: c.id, met: null, note: 'Needs human check' } : { criterionId: c.id, met: true, note: `Earlier proof: ${c.text}` })
  await t.db.insert(schema.reviews).values({ taskId: task.id, runId: run!.id, round: 0, headSha: 'approved-head', verdict: 'approved', summary: 'Feature checked', criteria, author: t.actor })
  await t.db.insert(schema.evidence).values(criteria.map(c => ({ taskId: task.id, runId: run!.id, criterionId: c.criterionId, round: 0, kind: 'note' as const, size: 0, note: c.note })))
  const branch = `corral/${task.ref.toLowerCase()}`
  const [epic] = options.epicMode
    ? await t.db.insert(schema.epics).values({ projectId: project.id, title: `Epic for ${task.ref}`, reviewMode: options.epicMode, branch: `epic/${task.ref.toLowerCase()}`, createdBy: t.actor }).returning()
    : []
  await t.db.update(schema.tasks).set({ status: 'in_progress', branch, headSha: 'approved-head', approvedHeadSha: 'approved-head', rebaseOnly: true, epicId: epic?.id ?? null }).where(eq(schema.tasks.id, task.id))
  t.github.setBranch(project.repository, branch, 'approved-head')
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: false })
  await t.orchestrator.schedule()
  const dev = (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'developer')).job
  await capture(`developer-prompt-${humanReview}.json`, { transport: 'Runner WebSocket assignment from isolated test server', developerAssignment: dev })
  t.github.setBranch(project.repository, branch, 'new-head')
  return { task, criteria, dev, epicBranch: epic?.branch ?? null }
}
async function submitted(humanReview = false, options: { epicMode?: 'each_task', checkFailures?: RebaseCheckFailure[], humanCheck?: boolean } = {}) {
  const { task, criteria, dev } = await rebaseRound(humanReview, options)
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

const file = (filename: string, patch: string): ChangedFile => ({ filename, status: 'modified', sha: `blob-${filename}-${patch}`, patch })
const approvedDiff = [file('app.ts', '@@ -1,2 +1,3 @@\n a\n+feature'), file('billing.ts', '@@ -9,2 +9,2 @@ tax\n-old\n+new')]
// The same billing.ts change further down, under a new base
const rebasedDiff = [file('app.ts', '@@ -1,3 +1,4 @@\n a\n+main\n+feature'), file('billing.ts', '@@ -40,2 +40,2 @@ invoice\n-old\n+new')]
function stubCompare(base: string, options: { oldDiff?: ChangedFile[], newDiff?: ChangedFile[], onBase?: ChangedFile[] } = {}) {
  t.github.setBranch(project.repository, base, 'new-base')
  t.github.setComparison('new-base', 'approved-head', { mergeBase: 'old-base', files: options.oldDiff ?? approvedDiff })
  t.github.setComparison('new-base', 'new-head', { mergeBase: 'new-base', files: options.newDiff ?? rebasedDiff })
  t.github.setComparison('old-base', 'new-base', { mergeBase: 'old-base', files: options.onBase ?? [file('lib/queue.ts', '+main')] })
}
async function reportRebase(dev: RunJob, review: 'trivial' | 'needs_review' = 'trivial') {
  const report = { outcome: 'pr_rebased', review, conflictedFiles: ['app.ts'], headSha: 'new-head', summary: 'app.ts: kept both sides', note: 'app.ts: kept both sides' }
  const response = await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', report)
  expect(response).toMatchObject({ ok: true })
  return { report, response }
}
async function nextReview(task: Task) {
  await t.orchestrator.schedule()
  return (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === 'reviewer')).job
}
// Ends the review so its run doesn't hold on to a runner slot
async function closeReview(review: RunJob) {
  await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'blocked', summary: 'Test finished' })
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
}
async function compareCalls(from: number) {
  return t.github.calls.slice(from).filter(c => c.method === 'compare')
}

it.each([
  { label: 'plain task', humanReview: false, epicMode: undefined },
  { label: 'humanReview task', humanReview: true, epicMode: undefined },
  { label: 'each_task epic task', humanReview: false, epicMode: 'each_task' as const }
])('verifies a trivial rebase without a review: $label', async ({ label, humanReview, epicMode }) => {
  const { task, criteria, dev, epicBranch } = await rebaseRound(humanReview, epicMode ? { epicMode } : {})
  stubCompare(epicBranch ?? 'main')
  const { report, response } = await reportRebase(dev)
  await t.orchestrator.schedule()

  const url = `${t.server!.url}/api/projects/${project.slug}/tasks/${task.number}`
  const body = await (await fetch(url)).json() as Task
  expect(body).toMatchObject({ status: 'ready_to_merge', reviewRounds: 0 })
  expect(body.acceptanceCriteria.every(c => c.met === true)).toBe(true)
  expect(body.latestReview?.criteria).toEqual(criteria)
  const reviewerRuns = await t.db.select().from(schema.runs).where(and(eq(schema.runs.taskId, task.id), eq(schema.runs.role, 'reviewer'), eq(schema.runs.state, 'running')))
  expect(reviewerRuns).toEqual([])
  const [row] = await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
  expect(row).toMatchObject({ headSha: 'new-head', rebaseOnly: false })

  const taskComments = await (await fetch(`${url}/comments`)).json() as { body: string }[]
  expect(taskComments.map(c => c.body)).toEqual(expect.arrayContaining([expect.stringContaining('Trivial rebase verified without review')]))
  const history = await (await fetch(`${url}/history`)).json() as { action: string, detail: Record<string, unknown> }[]
  expect(history).toEqual(expect.arrayContaining([expect.objectContaining({ action: 'rebase.verified', detail: expect.objectContaining({ headSha: 'new-head', approvedHeadSha: 'approved-head' }) })]))
  expect(history.some(e => e.action === 'task.transition' && e.detail.event === 'pr_rebased')).toBe(false)
  const inbox = await inboxItems()
  expect(inbox.needsYou.filter(item => item.taskId === task.id)).toEqual([])
  expect(inbox.activity.filter(item => item.taskId === task.id).map(item => item.preview)).toEqual(expect.arrayContaining([expect.stringContaining('without review')]))
  await capture(`verified-${label.replaceAll(' ', '-')}.json`, { report, response, request: { method: 'GET', url }, task: body, comments: taskComments, history, compareCalls: t.github.calls.filter(c => c.method === 'compare').slice(-3) })
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
})

it('sends a trivial rebase that changed an undeclared file to the reviewer, naming it', async () => {
  const { task, dev } = await rebaseRound(false, {})
  stubCompare('main', { newDiff: [...rebasedDiff.slice(0, 1), file('billing.ts', '@@ -9,2 +9,2 @@\n-old\n+different'), file('extra.ts', '+added')] })
  const { report } = await reportRebase(dev)
  const review = await nextReview(task)
  const [row] = await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
  expect(row).toMatchObject({ status: 'agent_review', rebaseOnly: true })
  expect(review.prompt).toContain('## Server check failed')
  expect(review.prompt).toContain('not in the developer\'s conflicted-file list: `billing.ts`, `extra.ts`')
  await capture('failed-outside-conflicts.json', { report, status: row!.status, reviewerAssignment: review })
  await closeReview(review)
})

// GitHub leaves the patch out, and the head blob is the same either side: this
// was A → C before the rebase and B → C after it, which overwrites the base's B
const binary = (filename: string, status: string): ChangedFile => ({ filename, status, sha: 'blob-c' })

it.each([
  ['a modified binary', 'modified'],
  ['a binary renamed with changes', 'renamed']
])('sends %s without a patch to the reviewer, naming it', async (_, status) => {
  const { task, dev } = await rebaseRound(false, {})
  stubCompare('main', { oldDiff: [...approvedDiff, binary('logo.png', status)], newDiff: [...rebasedDiff, binary('logo.png', status)] })
  const { report } = await reportRebase(dev)
  const review = await nextReview(task)
  const [row] = await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
  expect(row!.status).toBe('agent_review')
  expect(review.prompt).toContain('not in the developer\'s conflicted-file list: `logo.png`')
  await capture(`failed-no-patch-${status}.json`, { report, status: row!.status, reviewerAssignment: review })
  await closeReview(review)
})

it('still verifies a binary the task added, unchanged by the rebase', async () => {
  const { task, dev } = await rebaseRound(false, {})
  stubCompare('main', { oldDiff: [...approvedDiff, binary('logo.png', 'added')], newDiff: [...rebasedDiff, binary('logo.png', 'added')] })
  await reportRebase(dev)
  const [row] = await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
  expect(row!.status).toBe('ready_to_merge')
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
})

it('accepts a binary without a patch when the developer declared it', async () => {
  const { task, dev } = await rebaseRound(false, {})
  const declared = { ...binary('app.ts', 'modified') }
  stubCompare('main', { oldDiff: [declared, approvedDiff[1]!], newDiff: [declared, rebasedDiff[1]!] })
  await reportRebase(dev)
  const [row] = await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
  expect(row!.status).toBe('ready_to_merge')
  await t.request('PATCH', `/api/projects/${project.slug}`, { paused: true })
})

it.each(['docs/decisions.md', '.corral/wiki/claim-order.md', 'CORRAL.md', 'CLAUDE.md'])('sends a trivial rebase to the reviewer when the base changed %s', async (doc) => {
  const { task, dev } = await rebaseRound(false, {})
  stubCompare('main', { onBase: [file('lib/queue.ts', '+main'), file('src/CLAUDE.md', '+nested, not a project doc'), file(doc, '+changed')] })
  const { report } = await reportRebase(dev)
  const review = await nextReview(task)
  const [row] = await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
  expect(row!.status).toBe('agent_review')
  expect(review.prompt).toContain(`These project docs changed on the base since approval: \`${doc}\``)
  await capture(`failed-doc-${doc.replaceAll('/', '_')}.json`, { report, status: row!.status, reviewerAssignment: review })
  await closeReview(review)
})

it('names both sides of a doc renamed on the base', async () => {
  const { task, dev } = await rebaseRound(false, {})
  stubCompare('main', { onBase: [{ ...file('notes/old-prd.md', ''), status: 'renamed', previousFilename: 'docs/prd.md' }] })
  await reportRebase(dev)
  const review = await nextReview(task)
  expect(review.prompt).toContain('These project docs changed on the base since approval: `docs/prd.md`')
  await closeReview(review)
})

it('sends needs_review to the reviewer without running the check', async () => {
  const { task, dev } = await rebaseRound(false, {})
  stubCompare('main')
  const before = t.github.calls.length
  const { report } = await reportRebase(dev, 'needs_review')
  const review = await nextReview(task)
  const compares = await compareCalls(before)
  expect(compares).toEqual([])
  expect(review.prompt).not.toContain('## Server check failed')
  await capture('needs-review.json', { report, compareCalls: compares, reviewerAssignment: review })
  await closeReview(review)
})

it.each([0, 1, 2])('falls back to the rebase review when compare call %i fails', async (failing) => {
  const { task, dev } = await rebaseRound(false, {})
  stubCompare('main')
  const key = [['new-base', 'approved-head'], ['new-base', 'new-head'], ['old-base', 'new-base']][failing] as [string, string]
  t.github.setComparison(key[0], key[1], new Error('GitHub returned 502'))
  const { report, response } = await reportRebase(dev)
  const review = await nextReview(task)
  const [run] = await t.db.select().from(schema.runs).where(eq(schema.runs.id, dev.runId))
  expect(run).toMatchObject({ state: 'completed', outcome: 'pr_rebased' })
  const [entry] = await t.db.select().from(schema.auditLog).where(and(eq(schema.auditLog.taskId, task.id), sql`${schema.auditLog.detail}->>'event' = 'pr_rebased'`))
  expect(entry!.detail).toMatchObject({ checkError: 'GitHub returned 502', to: 'agent_review' })
  await capture(`compare-error-${failing}.json`, { report, response, developerRun: { state: run!.state, outcome: run!.outcome }, audit: entry!.detail, reviewerAssignment: review })
  await closeReview(review)
})

it('sends a verified rebase to the reviewer when the approval can\'t carry over', async () => {
  const { task, dev } = await rebaseRound(false, {})
  stubCompare('main')
  await t.db.delete(schema.reviews).where(eq(schema.reviews.taskId, task.id))
  await reportRebase(dev)
  const review = await nextReview(task)
  const [row] = await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id))
  expect(row!.status).toBe('agent_review')
  await closeReview(review)
})
