import { databaseFixture } from '@corral/db/testing'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EpicReviewItem, Inbox, Task } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { afterAll, beforeEach, expect, it } from 'vitest'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'

let t: TestApp
let runner: FakeRunner
databaseFixture('postgres', async () => {
  t = await createTestApp('postgres', { listen: true })
  await t.db.update(schema.agents).set({ concurrency: 20, wakeIntervalSeconds: null })
  runner = await FakeRunner.connect(t.server!.url)
})
afterAll(async () => {
  runner?.close()
  await t?.close()
})
beforeEach(() => {
  t.github.mergeResult = { merged: true, sha: 'squash-sha', message: 'merged' }
})

const inbox = async () => (await t.request('GET', '/api/inbox')).json() as Promise<Inbox>
const reload = async (id: string) => (await t.db.select().from(schema.epics).where(eq(schema.epics.id, id)))[0]!
const calls = (method: string) => t.github.calls.filter(c => c.method === method)
async function capture(name: string, data: unknown) {
  if (process.env.CORRAL_EPIC_EVIDENCE_DIR) await writeFile(join(process.env.CORRAL_EPIC_EVIDENCE_DIR, name), JSON.stringify(data, null, 2))
}

// An epic whose only task is Merged, with its PR approved by the human
async function approved(mode: 'epic' | 'each_task' = 'epic') {
  const project = await t.createProject({ defaultBranch: 'develop' })
  await t.db.update(schema.projects).set({ requiredChecks: ['ci'] }).where(eq(schema.projects.id, project.id))
  const [epic] = await t.db.insert(schema.epics).values({ projectId: project.id, createdBy: t.actor, title: `Saved searches · ${project.prefix}`, reviewMode: mode, branch: `corral/epic-${project.id}` }).returning()
  const head = `head-${project.id}`
  t.github.setBranch(project.repository, epic!.branch!, head)
  t.github.setBranch(project.repository, 'develop', `target-${project.id}`)
  t.github.setChecks(head, [{ name: 'ci', conclusion: 'success', url: null }])
  const task = await t.createTask(project.slug, { title: 'Search API', epicId: epic!.id, acceptanceCriteria: ['Search works'] })
  await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, task.id))
  await t.orchestrator.schedule()
  const job = (await runner.next('run.assign', m => m.job.epicId === epic!.id)).job
  expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Fits together' })).toMatchObject({ ok: true })
  const item = (await inbox()).needsYou.find(i => i.id === epic!.id) as EpicReviewItem
  expect((await t.request('POST', `/api/epics/${epic!.id}/review`, { action: 'approve', headSha: item.headSha })).status).toBe(200)
  const pr = [...t.github.pulls.values()].find(p => p.head === epic!.branch)!
  return { project, epic: epic!, task, head, pr }
}

it('squashes even when task PRs use another merge method', async () => {
  const { project, epic } = await approved()
  await t.db.update(schema.projects).set({ mergeMethod: 'merge' }).where(eq(schema.projects.id, project.id))
  await t.mergePass()
  expect(calls('merge').at(-1)!.args[2]).toBe('squash')
  expect((await reload(epic.id)).reviewState).toBe('merged')
})

it('holds an approved PR behind its target for the synchronizer, without touching GitHub\'s branch update', async () => {
  const { epic, head } = await approved()
  t.github.behind.set(head, 1)
  const before = t.github.calls.length
  await t.mergePass()
  expect(t.github.calls.slice(before).map(c => c.method)).not.toEqual(expect.arrayContaining(['merge', 'updateBranch']))
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'ready_to_merge', prHeadSha: head })
})

it('shows an up-to-date PR GitHub won\'t merge as an operational failure, and a retry looks again', async () => {
  const { epic, pr } = await approved()
  t.github.pulls.get(pr.number)!.mergeable = false
  await t.mergePass()
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'ready_to_merge', syncError: expect.stringContaining('can\'t merge') })
  expect(((await (await t.request('GET', `/api/epics/${epic.id}`)).json()) as { sync: unknown }).sync).toMatchObject({ state: 'failed' })
  expect((await inbox()).needsYou.some(i => i.id === epic.id)).toBe(false)
  expect((await t.request('POST', `/api/epics/${epic.id}/sync/retry`)).status).toBe(200)
  expect((await reload(epic.id)).syncError).toBeNull()
})

it('sends a failed required check back as a fix task in the epic', async () => {
  const { epic, head } = await approved()
  t.github.setChecks(head, [{ name: 'ci', conclusion: 'failure', url: 'http://ci' }])
  await t.mergePass()
  expect((await reload(epic.id)).reviewState).toBe('open')
  const fixes = await t.db.select().from(schema.tasks).where(eq(schema.tasks.epicId, epic.id))
  expect(fixes.find(row => row.title === 'Fix integration: CI failed on the epic PR')).toMatchObject({ status: 'ready' })
})

it('returns a repeatedly refused merge to the human, whose approval retries it', async () => {
  const { epic, head } = await approved()
  t.github.mergeResult = { merged: false, sha: null, message: 'Required reviews missing' }
  for (let i = 0; i < 3; i++) await t.mergePass()
  expect((await reload(epic.id)).reviewState).toBe('human_review')
  expect((await inbox()).needsYou.find(i => i.id === epic.id)).toMatchObject({ type: 'epic_review' })
  t.github.mergeResult = { merged: true, sha: 'squash-sha', message: 'merged' }
  expect((await t.request('POST', `/api/epics/${epic.id}/review`, { action: 'approve', headSha: head })).status).toBe(200)
  await t.mergePass()
  expect((await reload(epic.id)).reviewState).toBe('merged')
})

it('counts a PR merged on GitHub, and leaves a closed one to the human', async () => {
  const merged = await approved()
  t.github.pulls.get(merged.pr.number)!.merged = true
  t.github.pulls.get(merged.pr.number)!.state = 'closed'
  await t.mergePass()
  expect((await reload(merged.epic.id)).reviewState).toBe('merged')
  const closed = await approved()
  t.github.pulls.get(closed.pr.number)!.state = 'closed'
  await t.mergePass()
  expect(await reload(closed.epic.id)).toMatchObject({ reviewState: 'open', approvedHeadSha: null, approvedBaseSha: null })
  expect((await inbox()).activity.find(a => a.epicId === closed.epic.id)!.body).toBe('Epic PR closed on GitHub')
})

it('holds tasks in a dependent epic until the epic PR merges, though every task is Merged', async () => {
  const { project, epic, head } = await approved()
  const [dependent] = await t.db.insert(schema.epics).values({ projectId: project.id, createdBy: t.actor, title: 'Search sharing', reviewMode: 'direct' }).returning()
  await t.db.insert(schema.epicDependencies).values({ projectId: project.id, epicId: dependent!.id, dependsOnEpicId: epic.id })
  const waiting = await t.createTask(project.slug, { title: 'Share a search', epicId: dependent!.id, acceptanceCriteria: ['Sharing works'] })
  expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${waiting.number}/transitions`, { type: 'approve' })).status).toBe(200)
  const get = async () => (await t.request('GET', `/api/projects/${project.slug}/tasks/${waiting.number}`)).json() as Promise<Task>

  t.github.setChecks(head, [{ name: 'ci', conclusion: 'pending', url: null }])
  await t.mergePass()
  await t.orchestrator.schedule()
  const held = await get()
  expect(held).toMatchObject({ status: 'ready', waitingOnEpics: [{ id: epic.id, title: epic.title }] })
  expect(runner.received.some(m => m.type === 'run.assign' && m.job.taskId === waiting.id)).toBe(false)

  t.github.setChecks(head, [{ name: 'ci', conclusion: 'success', url: null }])
  await t.mergePass()
  await t.orchestrator.schedule()
  const { job } = await runner.next('run.assign', m => m.job.taskId === waiting.id)
  expect(job.role).toBe('developer')
  const claimed = await get()
  expect(claimed).toMatchObject({ status: 'in_progress', waitingOnEpics: [] })
  await capture('dependent-epic.json', { beforeEpicPrMerged: { epicTasks: 'all Merged', dependentTask: held }, afterEpicPrMerged: { epic: await reload(epic.id), dependentTask: claimed, assignedRun: { runId: job.runId, role: job.role, taskId: job.taskId } } })
})
