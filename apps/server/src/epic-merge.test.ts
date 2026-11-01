import { databaseFixture } from '@corral/db/testing'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EpicConflictItem, EpicReviewItem, Inbox, RunJob, Task } from '@corral/contracts'
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
  const fallback = runner.onJob
  runner.onJob = job => job.kind === 'rebase_conflicts' ? { kind: 'rebase_conflicts', files: ['src/routes/search.ts', 'docs/search.md'] } : fallback(job)
})
afterAll(async () => {
  runner?.close()
  await t?.close()
})
beforeEach(() => {
  t.github.updateBranchResult = true
  t.github.onUpdateBranch = null
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

it('rebases a moved epic branch, keeps the approval, reruns checks, then squashes once', async () => {
  const { project, epic, head, pr } = await approved()
  t.github.behind.set(head, 2)
  const before = t.github.calls.length
  await t.orchestrator.merges.tick()
  expect(calls('updateBranch').at(-1)!.args).toEqual([project.repository, pr.number, head])
  expect(t.github.calls.slice(before).some(c => c.method === 'merge')).toBe(false)
  expect((await reload(epic.id)).rebaseRequested).toBe(true)

  // GitHub's rebase moves the head; CI hasn't finished on it
  t.github.setBranch(project.repository, epic.branch!, `${head}-rebased`)
  t.github.setChecks(`${head}-rebased`, [{ name: 'ci', conclusion: 'pending', url: null }])
  await t.orchestrator.schedule()
  await t.orchestrator.merges.tick()
  await t.orchestrator.merges.tick()
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'ready_to_merge', prHeadSha: `${head}-rebased`, rebaseRequested: false })
  expect(t.github.calls.slice(before).some(c => c.method === 'merge')).toBe(false)
  expect(await t.db.select().from(schema.runs).where(eq(schema.runs.epicId, epic.id))).toHaveLength(1)

  t.github.setChecks(`${head}-rebased`, [{ name: 'ci', conclusion: 'success', url: null }])
  await t.orchestrator.merges.tick()
  const merges = t.github.calls.slice(before).filter(c => c.method === 'merge')
  expect(merges.map(c => c.args)).toEqual([[project.repository, pr.number, 'squash', `${head}-rebased`]])
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'merged', mergeCommitSha: 'squash-sha' })
  expect(calls('deleteBranch').at(-1)!.args).toEqual([project.repository, epic.branch])
  await capture('rebase-then-squash.json', { scope: 'Isolated server with simulated GitHub', githubCalls: t.github.calls.slice(before), epic: await reload(epic.id) })
})

it('keeps the approval when a reconcile pass sees the new head before updateBranch returns', async () => {
  const { project, epic, head } = await approved()
  t.github.behind.set(head, 1)
  const rebased = `${head}-rebased`
  t.github.setChecks(rebased, [{ name: 'ci', conclusion: 'success', url: null }])
  t.github.onUpdateBranch = async () => {
    t.github.setBranch(project.repository, epic.branch!, rebased)
    await t.orchestrator.schedule()
  }
  await t.orchestrator.merges.tick()
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'ready_to_merge', rebaseRequested: true })
  await t.orchestrator.merges.tick()
  await t.orchestrator.merges.tick()
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'merged', prHeadSha: rebased })
  expect(await t.db.select().from(schema.runs).where(eq(schema.runs.epicId, epic.id))).toHaveLength(1)
})

it('clears the rebase flag when updateBranch throws, then asks again', async () => {
  const { epic, head } = await approved()
  t.github.behind.set(head, 1)
  t.github.onUpdateBranch = async () => {
    throw new Error('GitHub timed out')
  }
  await t.orchestrator.merges.tick()
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'ready_to_merge', rebaseRequested: false })
  t.github.onUpdateBranch = null
  await t.orchestrator.merges.tick()
  expect((await reload(epic.id)).rebaseRequested).toBe(true)
})

it('asks again when a requested rebase never shows on the PR', async () => {
  const { project, epic, head } = await approved()
  const rebases = () => calls('updateBranch').filter(c => c.args[0] === project.repository)
  t.github.behind.set(head, 1)
  await t.orchestrator.merges.tick()
  const asked = rebases().length
  await t.orchestrator.merges.tick()
  expect(rebases()).toHaveLength(asked)
  t.clock.now = new Date(t.clock.now.getTime() + 6 * 60_000)
  await t.orchestrator.merges.tick()
  await t.orchestrator.merges.tick()
  expect(rebases()).toHaveLength(asked + 1)
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'ready_to_merge', rebaseRequested: true })
})

it('skips an epic a slower pass is still advancing, so no false conflict is raised', async () => {
  const { project, epic, head } = await approved()
  const rebases = () => calls('updateBranch').filter(c => c.args[0] === project.repository)
  t.github.behind.set(head, 1)
  t.github.onUpdateBranch = () => t.orchestrator.merges.tick()
  await t.orchestrator.merges.tick()
  expect(rebases()).toHaveLength(1)
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'ready_to_merge', conflictFiles: null })
})

it('squashes even when task PRs use another merge method', async () => {
  const { project, epic } = await approved()
  await t.db.update(schema.projects).set({ mergeMethod: 'merge' }).where(eq(schema.projects.id, project.id))
  await t.orchestrator.merges.tick()
  expect(calls('merge').at(-1)!.args[2]).toBe('squash')
  expect((await reload(epic.id)).reviewState).toBe('merged')
})

it('blocks a conflicted rebase with an Inbox item and hands it to a developer run on the epic branch', async () => {
  const { project, epic, head, pr, task } = await approved()
  t.github.behind.set(head, 1)
  t.github.updateBranchResult = false
  const before = t.github.calls.length
  await t.orchestrator.merges.tick()
  await t.orchestrator.merges.tick()
  expect(t.github.calls.slice(before).filter(c => c.method === 'updateBranch')).toHaveLength(1)
  expect(t.github.calls.slice(before).some(c => c.method === 'merge')).toBe(false)
  const box = await inbox()
  const item = box.needsYou.find(i => i.id === epic.id) as EpicConflictItem
  expect(item).toMatchObject({ type: 'epic_conflict', subject: epic.title, targetBranch: 'develop', files: ['src/routes/search.ts', 'docs/search.md'] })
  expect(item.body).toContain('src/routes/search.ts')
  expect(box.activity.find(a => a.epicId === epic.id)!.body).toContain('Epic PR conflict: src/routes/search.ts')
  await capture('conflict-inbox.json', { request: { method: 'GET', url: '/api/inbox' }, status: 200, needsYouItem: item, targetBranchHead: t.github.branches.get(`${project.repository}#develop`), mergeCalls: t.github.calls.slice(before).filter(c => c.method === 'merge') })

  // A stale head can't start the hand-off
  expect((await t.request('POST', `/api/epics/${epic.id}/review`, { action: 'rebase', headSha: 'old' })).status).toBe(409)
  expect((await t.request('POST', `/api/epics/${epic.id}/review`, { action: 'rebase', headSha: item.headSha })).status).toBe(200)
  expect((await inbox()).needsYou.some(i => i.id === epic.id)).toBe(false)
  await t.orchestrator.schedule()
  const dev = (await runner.next('run.assign', m => m.job.role === 'developer' && m.job.branch === epic.branch)).job as RunJob
  expect(dev).toMatchObject({ baseBranch: 'develop' })
  expect(dev.prompt).toContain('src/routes/search.ts')
  expect(dev.prompt).toContain('git rebase origin/develop')
  expect(dev.prompt).toContain('Squash the epic branch')
  expect(dev.prompt).toContain('Keep every `Corral-Submission:` trailer')
  expect(dev.prompt).not.toContain('Run `pnpm run check`')

  const rebase = (await t.db.select().from(schema.tasks).where(eq(schema.tasks.epicId, epic.id))).find(row => row.id !== task.id)!
  const [criterion] = await t.db.select().from(schema.acceptanceCriteria).where(eq(schema.acceptanceCriteria.taskId, rebase.id))
  t.github.setBranch(project.repository, epic.branch!, `${head}-resolved`)
  await runner.call(dev.runId, dev.leaseEpoch, 'attach_evidence', { criterionId: criterion!.id, kind: 'note', note: 'Kept both route changes' })
  const prs = t.github.pulls.size
  expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'pr_updated', note: 'Rebased the epic branch and resolved both conflicts', summary: 'Rebased', headSha: `${head}-resolved` })).toMatchObject({ ok: true })
  expect(t.github.pulls.size).toBe(prs)
  expect(pr.body).not.toContain('Rebased')

  await t.orchestrator.schedule()
  const review = (await runner.next('run.assign', m => m.job.role === 'reviewer' && m.job.taskId === rebase.id)).job
  expect(review.headSha).toBe(`${head}-resolved`)
  expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Both sides kept', criteria: [{ criterionId: criterion!.id, met: true, note: '' }] })).toMatchObject({ ok: true })
  await t.orchestrator.merges.tick()
  expect((await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, rebase.id)))[0]!.status).toBe('merged')

  // Back to integration review, then to the human, on the new head
  await t.orchestrator.schedule()
  const integration = (await runner.next('run.assign', m => m.job.epicId === epic.id)).job
  expect(integration.headSha).toBe(`${head}-resolved`)
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'in_review', conflictFiles: null, prHeadSha: `${head}-resolved` })
  expect(await runner.call(integration.runId, integration.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Still fits' })).toMatchObject({ ok: true })
  expect((await inbox()).needsYou.find(i => i.id === epic.id)).toMatchObject({ type: 'epic_review' })
})

it('keeps the gates on an epic rebase when no required check would verify it', async () => {
  const { project, epic, head } = await approved()
  await t.db.update(schema.projects).set({ requiredChecks: [] }).where(eq(schema.projects.id, project.id))
  t.github.behind.set(head, 1)
  t.github.updateBranchResult = false
  await t.orchestrator.merges.tick()
  await t.orchestrator.merges.tick()
  const item = (await inbox()).needsYou.find(i => i.id === epic.id) as EpicConflictItem
  expect((await t.request('POST', `/api/epics/${epic.id}/review`, { action: 'rebase', headSha: item.headSha })).status).toBe(200)
  await t.orchestrator.schedule()
  const dev = (await runner.next('run.assign', m => m.job.role === 'developer' && m.job.branch === epic.branch)).job as RunJob
  expect(dev.prompt).toContain('Run the project\'s gates, then report pr_updated')
  expect(dev.prompt).toContain('Run `pnpm run check` when available')
  expect(dev.prompt).not.toContain('Corral-Submission')
})

it('sends a failed required check back as a fix task in the epic', async () => {
  const { epic, head } = await approved()
  t.github.setChecks(head, [{ name: 'ci', conclusion: 'failure', url: 'http://ci' }])
  await t.orchestrator.merges.tick()
  expect((await reload(epic.id)).reviewState).toBe('open')
  const fixes = await t.db.select().from(schema.tasks).where(eq(schema.tasks.epicId, epic.id))
  expect(fixes.find(row => row.title === 'Fix integration: CI failed on the epic PR')).toMatchObject({ status: 'ready' })
})

it('returns a repeatedly refused merge to the human, whose approval retries it', async () => {
  const { epic, head } = await approved()
  t.github.mergeResult = { merged: false, sha: null, message: 'Required reviews missing' }
  for (let i = 0; i < 3; i++) await t.orchestrator.merges.tick()
  expect((await reload(epic.id)).reviewState).toBe('human_review')
  expect((await inbox()).needsYou.find(i => i.id === epic.id)).toMatchObject({ type: 'epic_review' })
  t.github.mergeResult = { merged: true, sha: 'squash-sha', message: 'merged' }
  expect((await t.request('POST', `/api/epics/${epic.id}/review`, { action: 'approve', headSha: head })).status).toBe(200)
  await t.orchestrator.merges.tick()
  expect((await reload(epic.id)).reviewState).toBe('merged')
})

it('counts a PR merged on GitHub, and leaves a closed one to the human', async () => {
  const merged = await approved()
  t.github.pulls.get(merged.pr.number)!.merged = true
  t.github.pulls.get(merged.pr.number)!.state = 'closed'
  await t.orchestrator.merges.tick()
  expect((await reload(merged.epic.id)).reviewState).toBe('merged')
  const closed = await approved()
  t.github.pulls.get(closed.pr.number)!.state = 'closed'
  await t.orchestrator.merges.tick()
  expect((await reload(closed.epic.id)).reviewState).toBe('open')
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
  await t.orchestrator.merges.tick()
  await t.orchestrator.schedule()
  const held = await get()
  expect(held).toMatchObject({ status: 'ready', waitingOnEpics: [{ id: epic.id, title: epic.title }] })
  expect(runner.received.some(m => m.type === 'run.assign' && m.job.taskId === waiting.id)).toBe(false)

  t.github.setChecks(head, [{ name: 'ci', conclusion: 'success', url: null }])
  await t.orchestrator.merges.tick()
  await t.orchestrator.schedule()
  const { job } = await runner.next('run.assign', m => m.job.taskId === waiting.id)
  expect(job.role).toBe('developer')
  const claimed = await get()
  expect(claimed).toMatchObject({ status: 'in_progress', waitingOnEpics: [] })
  await capture('dependent-epic.json', { beforeEpicPrMerged: { epicTasks: 'all Merged', dependentTask: held }, afterEpicPrMerged: { epic: await reload(epic.id), dependentTask: claimed, assignedRun: { runId: job.runId, role: job.role, taskId: job.taskId } } })
})
