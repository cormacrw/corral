import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EpicReviewItem, Inbox, RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

let t: TestApp
let runner: FakeRunner
beforeAll(async () => {
  t = await createTestApp('postgres', { listen: true })
  await t.db.update(schema.agents).set({ concurrency: 20, wakeIntervalSeconds: null })
  await t.db.update(schema.agents).set({ paused: true }).where(eq(schema.agents.role, 'developer'))
  runner = await FakeRunner.connect(t.server!.url)
})
afterAll(async () => {
  runner?.close()
  await t?.close()
})
const inbox = async () => (await fetch(`${t.server!.url}/api/inbox`)).json() as Promise<Inbox>
async function capture(name: string, data: unknown) {
  if (process.env.CORRAL_EPIC_EVIDENCE_DIR) await writeFile(join(process.env.CORRAL_EPIC_EVIDENCE_DIR, name), JSON.stringify(data, null, 2))
}
async function setup(mode: 'epic' | 'each_task' | 'direct' = 'epic') {
  const project = await t.createProject({ defaultBranch: 'develop' })
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  const [epic] = await t.db.insert(schema.epics).values({ projectId: project.id, createdBy: t.actor, title: `Saved searches · ${project.prefix}`, description: 'Search API and UI work together', reviewMode: mode, branch: `corral/epic-${project.id}` }).returning()
  t.github.setBranch(project.repository, epic!.branch!, `combined-${project.id}`)
  const task = await t.createTask(project.slug, { title: 'Search API', epicId: epic!.id, acceptanceCriteria: ['Search API returns saved searches'] })
  const other = await t.createTask(project.slug, { title: 'Search UI', epicId: epic!.id, acceptanceCriteria: ['UI displays saved searches from the API'] })
  await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, task.id))
  await t.db.update(schema.tasks).set({ status: 'ready', paused: true }).where(eq(schema.tasks.id, other.id))
  const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'developer'))
  const [run] = await t.db.insert(schema.runs).values({ agentId: agent!.id, projectId: project.id, taskId: task.id, role: 'developer', state: 'completed' }).returning()
  await t.db.insert(schema.evidence).values({ runId: run!.id, taskId: task.id, criterionId: task.acceptanceCriteria[0]!.id, round: 0, size: 0, kind: 'note', note: 'Search API returns saved searches' })
  const [uiRun] = await t.db.insert(schema.runs).values({ agentId: agent!.id, projectId: project.id, taskId: other.id, role: 'developer', state: 'completed' }).returning()
  await t.db.insert(schema.evidence).values({ runId: uiRun!.id, taskId: other.id, criterionId: other.acceptanceCriteria[0]!.id, round: 0, size: 0, kind: 'note', note: 'UI uses the same saved search response fields as the API' })
  await t.db.update(schema.projects).set({ paused: false }).where(eq(schema.projects.id, project.id))
  return { project, epic: epic!, task, other }
}
async function lastMerge(otherId: string, epicId: string) {
  await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, otherId))
  await t.orchestrator.schedule()
  return (await runner.next('run.assign', m => m.job.epicId === epicId)).job
}
async function report(job: RunJob, outcome: 'approved' | 'changes_requested') {
  return runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome, summary: outcome === 'approved' ? 'Checked API/UI contract and combined behavior; gates rerun without cache.' : 'UI sends the wrong search field; align it with the API.' })
}

it.each(['epic', 'each_task'] as const)('opens %s PR only after the last board task merges; integration approval alone exposes all tasks and evidence', async (mode) => {
  const { project, epic, task, other } = await setup(mode)
  await t.createTask(project.slug, { epicId: epic.id, title: 'Future backlog work' })
  const removed = await t.createTask(project.slug, { epicId: epic.id, title: 'Deleted work' })
  await t.db.update(schema.tasks).set({ deletedAt: new Date(), status: 'ready' }).where(eq(schema.tasks.id, removed.id))
  await t.orchestrator.schedule()
  expect([...t.github.pulls.values()].some(p => p.head === epic.branch)).toBe(false)
  const job = await lastMerge(other.id, epic.id)
  const pr = [...t.github.pulls.values()].find(p => p.head === epic.branch)!
  expect(pr.base).toBe('develop')
  expect(pr.body).toContain(task.ref)
  expect(pr.body).toContain(other.ref)
  expect(pr.body).toContain(`http://corral.test/tasks/${task.ref}`)
  expect(pr.body).not.toContain('Future backlog work')
  if (mode === 'epic') await capture('epic-open.json', { scope: 'Isolated server with simulated GitHub, no remote PR created', board: [task.ref, other.ref], githubRequest: t.github.calls.find(c => c.method === 'openPullRequest' && c.args[0] === project.repository), githubResponse: pr, reviewerAssignment: job })
  expect(job).toMatchObject({ role: 'reviewer', taskId: null, branch: epic.branch, headSha: pr.headSha, baseBranch: 'develop' })
  expect(job.prompt).toContain('git diff origin/develop...HEAD')
  expect(job.prompt).toContain('WITHOUT THE CACHE')
  expect(job.prompt).toContain('Search API returns saved searches')
  expect(job.prompt).toContain(task.acceptanceCriteria[0]!.text)
  expect((await inbox()).needsYou.some(i => i.id === epic.id)).toBe(false)
  const context = await runner.call(job.runId, job.leaseEpoch, 'get_task', {})
  expect(context).toMatchObject({ ok: true, result: { epicId: epic.id, tasks: expect.any(Array) } })
  const [proof] = await t.db.select({ id: schema.evidence.id }).from(schema.evidence).where(eq(schema.evidence.taskId, task.id))
  expect(await runner.call(job.runId, job.leaseEpoch, 'get_evidence', { evidenceId: proof!.id })).toMatchObject({ ok: true, result: { text: 'Search API returns saved searches' } })
  expect(await report(job, 'approved')).toMatchObject({ ok: true })
  const item = (await inbox()).needsYou.find(i => i.id === epic.id) as EpicReviewItem
  expect(item.type).toBe('epic_review')
  if (mode === 'epic') await capture('approved-inbox.json', { request: { method: 'GET', url: `${t.server!.url}/api/inbox` }, status: 200, response: await inbox(), project })
  expect(item.tasks.map(e => e.task.id)).toEqual([task.id, other.id])
  expect(item.tasks[0]!.evidence[0]!.note).toBe('Search API returns saved searches')
  // No duplicate PR or reviewer run while human review is pending.
  await t.orchestrator.schedule()
  expect([...t.github.pulls.values()].filter(p => p.head === epic.branch)).toHaveLength(1)
  expect((await t.db.select().from(schema.runs).where(eq(schema.runs.epicId, epic.id)))).toHaveLength(1)
  const approved = await t.request('POST', `/api/epics/${epic.id}/review`, { action: 'approve', headSha: item.headSha })
  expect(approved.status).toBe(200)
  expect((await inbox()).needsYou.some(i => i.id === epic.id)).toBe(false)
  expect(t.github.calls.some(c => c.method === 'merge')).toBe(false)
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
})

it('keeps changes requested out of Inbox and creates a Ready fix task', async () => {
  const { project, epic, other } = await setup()
  const job = await lastMerge(other.id, epic.id)
  expect(await report(job, 'changes_requested')).toMatchObject({ ok: true })
  expect((await inbox()).needsYou.some(i => i.id === epic.id)).toBe(false)
  const fixes = await t.db.select().from(schema.tasks).where(eq(schema.tasks.epicId, epic.id))
  const fix = fixes.find(t => t.title.startsWith('Fix integration:'))!
  expect(fix).toMatchObject({ status: 'ready', epicId: epic.id })
  await capture('changes-requested.json', { reviewerReport: { outcome: 'changes_requested', summary: 'UI sends the wrong search field; align it with the API.' }, request: { method: 'GET', url: `${t.server!.url}/api/inbox` }, status: 200, response: await inbox(), epic: await (await fetch(`${t.server!.url}/api/epics/${epic.id}`)).json(), fixTask: fix })
  expect(JSON.stringify(fix.description)).toContain('wrong search field')
  expect(fix.title).toBe('Fix integration: UI sends the wrong search field; align it with the API')
  const [held] = await t.db.select().from(schema.epics).where(eq(schema.epics.id, epic.id))
  expect(held!.reviewState).toBe('changes_requested')
  // Finishing the fix reuses the PR and starts a fresh integration review.
  await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, fix.id))
  await t.orchestrator.schedule()
  const second = (await runner.next('run.assign', m => m.job.epicId === epic.id && m.job.runId !== job.runId)).job
  expect(await report(second, 'approved')).toMatchObject({ ok: true })
  expect((await inbox()).needsYou.some(i => i.id === epic.id)).toBe(true)
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
})

it('invalidates human and in-flight reviews when Backlog work reaches the board', async () => {
  const { project, epic, other } = await setup()
  const job = await lastMerge(other.id, epic.id)
  expect(await report(job, 'approved')).toMatchObject({ ok: true })
  const item = (await inbox()).needsYou.find(i => i.id === epic.id) as EpicReviewItem
  const added = await t.createTask(project.slug, { epicId: epic.id, title: 'New board requirement' })
  expect((await inbox()).needsYou.some(i => i.id === epic.id)).toBe(true)
  expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${added.number}/transitions`, { type: 'approve' })).status).toBe(200)
  expect((await inbox()).needsYou.some(i => i.id === epic.id)).toBe(false)
  const [held] = await t.db.select().from(schema.epics).where(eq(schema.epics.id, epic.id))
  expect(held!.reviewState).toBe('open')
  await capture('added-task.json', { before: item, addedTask: added, action: { method: 'POST', path: `/api/projects/${project.slug}/tasks/${added.number}/transitions`, body: { type: 'approve' }, status: 200 }, after: { request: { method: 'GET', url: `${t.server!.url}/api/inbox` }, status: 200, response: await inbox(), epic: held } })
  expect((await t.request('POST', `/api/epics/${epic.id}/review`, { action: 'approve', headSha: item.headSha })).status).toBe(409)
  const next = await lastMerge(added.id, epic.id)
  const late = await t.createTask(project.slug, { epicId: epic.id, title: 'Another requirement' })
  await t.request('POST', `/api/projects/${project.slug}/tasks/${late.number}/transitions`, { type: 'approve' })
  expect(await report(next, 'approved')).toMatchObject({ ok: false })
  expect((await inbox()).needsYou.some(i => i.id === epic.id)).toBe(false)
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
})

const reviewState = async (epicId: string) => (await t.db.select().from(schema.epics).where(eq(schema.epics.id, epicId)))[0]!.reviewState
const fixOf = async (epicId: string) => (await t.db.select().from(schema.tasks).where(eq(schema.tasks.epicId, epicId))).find(t => t.title.startsWith('Fix integration:'))!

it('human changes requested create a fix, hold the PR, and bring the same PR back after the fix merges', async () => {
  const { project, epic, other } = await setup()
  const job = await lastMerge(other.id, epic.id)
  expect(await report(job, 'approved')).toMatchObject({ ok: true })
  const pullsBefore = [...t.github.pulls.values()].filter(p => p.head === epic.branch)
  const path = `/api/epics/${epic.id}/review`
  expect((await t.request('POST', path, { action: 'approve', headSha: 'old-head' })).status).toBe(409)
  const feedback = 'A few problems:\n\n- Deleting a saved search does not ask for confirmation.\n- The empty state still says "No results"'
  const requested = await t.request('POST', path, { action: 'request_changes', headSha: job.headSha, text: feedback })
  expect(requested.status).toBe(200)
  const after = await inbox()
  expect(after.needsYou.some(i => i.id === epic.id)).toBe(false)
  expect(after.resolved.some(i => i.epicId === epic.id && i.preview.includes('You requested changes'))).toBe(true)
  expect(await reviewState(epic.id)).toBe('changes_requested')
  const fix = await fixOf(epic.id)
  expect(fix).toMatchObject({ status: 'ready', epicId: epic.id, title: 'Fix integration: Deleting a saved search does not ask for confirmation' })
  expect(JSON.stringify(fix.description)).toContain('does not ask for confirmation')
  const criteria = await t.db.select().from(schema.acceptanceCriteria).where(eq(schema.acceptanceCriteria.taskId, fix.id)).orderBy(schema.acceptanceCriteria.position)
  expect(criteria.map(c => c.text)).toEqual(['Deleting a saved search does not ask for confirmation.', 'The empty state still says "No results"'])
  await capture('human-changes-requested.json', { request: { method: 'POST', path, body: { action: 'request_changes', headSha: job.headSha, text: feedback } }, status: requested.status, epicReviewState: await reviewState(epic.id), fixTask: { ...fix, acceptanceCriteria: criteria.map(c => c.text) }, inboxNeedsYou: after.needsYou.filter(i => i.id === epic.id), inboxResolved: after.resolved.filter(i => i.epicId === epic.id) })

  // Nothing can approve or merge the PR while the changes are outstanding,
  // and new board work doesn't clear the state.
  expect((await t.request('POST', path, { action: 'approve', headSha: job.headSha })).status).toBe(409)
  const added = await t.createTask(project.slug, { epicId: epic.id, title: 'Late requirement' })
  await t.request('POST', `/api/projects/${project.slug}/tasks/${added.number}/transitions`, { type: 'approve' })
  await t.orchestrator.schedule()
  expect(await reviewState(epic.id)).toBe('changes_requested')
  expect(t.github.calls.some(c => c.method === 'merge')).toBe(false)
  await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, added.id))

  // The fix merges into the epic branch: its head moves and review starts over.
  t.github.setBranch(project.repository, epic.branch!, 'fixed-head')
  await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, fix.id))
  await t.orchestrator.schedule()
  const second = (await runner.next('run.assign', m => m.job.epicId === epic.id && m.job.runId !== job.runId)).job
  expect(second.headSha).toBe('fixed-head')
  expect(await reviewState(epic.id)).toBe('in_review')
  expect((await inbox()).needsYou.some(i => i.id === epic.id)).toBe(false)
  expect(await report(second, 'approved')).toMatchObject({ ok: true })
  const back = (await inbox()).needsYou.find(i => i.id === epic.id) as EpicReviewItem
  expect(back).toMatchObject({ type: 'epic_review', headSha: 'fixed-head' })
  expect(back.tasks.map(e => e.task.id)).toContain(fix.id)
  const pullsAfter = [...t.github.pulls.values()].filter(p => p.head === epic.branch)
  expect(pullsAfter.map(p => p.number)).toEqual(pullsBefore.map(p => p.number))
  await capture('fix-merged-inbox.json', { epicReviewState: await reviewState(epic.id), prNumber: pullsAfter[0]!.number, secondReviewAssignment: { runId: second.runId, headSha: second.headSha, role: second.role }, inboxItem: { id: back.id, type: back.type, headSha: back.headSha, prUrl: back.prUrl, tasks: back.tasks.map(e => e.task.ref) } })
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
})

it('sends the epic PR back to review if its fix task is dropped from the board', async () => {
  const { project, epic, other } = await setup()
  const job = await lastMerge(other.id, epic.id)
  expect(await report(job, 'changes_requested')).toMatchObject({ ok: true })
  const fix = await fixOf(epic.id)
  await t.db.update(schema.tasks).set({ deletedAt: new Date() }).where(eq(schema.tasks.id, fix.id))
  await t.orchestrator.schedule()
  const second = (await runner.next('run.assign', m => m.job.epicId === epic.id && m.job.runId !== job.runId)).job
  expect(second.headSha).toBe(job.headSha)
  expect(await reviewState(epic.id)).toBe('in_review')
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
})

it('never opens epic PRs in direct mode', async () => {
  const { project, epic, other } = await setup('direct')
  await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, other.id))
  await t.orchestrator.schedule()
  expect([...t.github.pulls.values()].some(p => p.head === epic.branch)).toBe(false)
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
})

it('fences a moved PR head and retries an expired integration lease', async () => {
  const { project, epic, other } = await setup()
  const job = await lastMerge(other.id, epic.id)
  t.github.setBranch(project.repository, epic.branch!, 'new-combined-head')
  expect(await report(job, 'approved')).toMatchObject({ ok: false })
  expect((await inbox()).needsYou.some(i => i.id === epic.id)).toBe(false)
  await t.orchestrator.schedule()
  const next = (await runner.next('run.assign', m => m.job.epicId === epic.id && m.job.runId !== job.runId)).job
  expect(next.headSha).toBe('new-combined-head')
  // Two simultaneous scheduling calls never duplicate the active review.
  await Promise.all([t.orchestrator.schedule(), t.orchestrator.schedule()])
  const live = await t.db.select().from(schema.runs).where(eq(schema.runs.epicId, epic.id))
  expect(live.filter(r => r.state === 'queued' || r.state === 'running')).toHaveLength(1)
  t.clock.now = new Date(t.clock.now.getTime() + 16 * 60 * 1000)
  await t.orchestrator.sweepLeases()
  expect(await report(next, 'approved')).toMatchObject({ ok: false })
  await t.orchestrator.schedule()
  const retried = (await runner.next('run.assign', m => m.job.epicId === epic.id && m.job.runId !== next.runId && m.job.runId !== job.runId)).job
  expect(await report(retried, 'approved')).toMatchObject({ ok: true })
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
})

it('starts no integration review until a reviewer runner has a free slot, then records the runner on the run', async () => {
  const { epic, other } = await setup()
  await t.db.update(schema.agents).set({ paused: true }).where(eq(schema.agents.role, 'reviewer'))
  await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, other.id))
  await t.orchestrator.schedule()
  await t.db.update(schema.agents).set({ paused: false }).where(eq(schema.agents.role, 'reviewer'))
  const [reviewer] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'reviewer'))
  expect(await t.orchestrator.epicPrs.claim(reviewer!.id, async () => null)).toBeNull()
  expect(await t.db.select().from(schema.runs).where(eq(schema.runs.epicId, epic.id))).toEqual([])
  await t.orchestrator.schedule()
  const { job } = await runner.next('run.assign', m => m.job.epicId === epic.id)
  const [run] = await t.db.select().from(schema.runs).where(eq(schema.runs.id, job.runId))
  expect(run!.runnerId).toBe('r1')
})
