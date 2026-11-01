import type { ApiErrorBody, EpicReview, Task } from '@corral/contracts'
import type { Actor } from '@corral/core'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { appendAudit, auditEvent } from './audit.ts'
import { createEpicFixTask } from './epic-prs.ts'
import { GitHubError, type ChangedFile, type Comparison } from './github.ts'
import { createTestApp, type TestApp } from './test-app.ts'

const { acceptanceCriteria, agents, epicReviewRounds, epics, evidence, projects, reviews, runs, taskSubmissions, tasks } = schema

let t: TestApp
const comparison = (mergeBase: string, files: ChangedFile[]): Comparison => ({ mergeBase, files })
const changed = (filename: string, patch: string): ChangedFile => ({ filename, status: 'modified', sha: `blob-${patch}`, additions: 1, deletions: 0, patch })

beforeAll(async () => {
  t = await createTestApp('pglite')
})
afterAll(async () => {
  await t?.close()
})

async function capture(name: string, data: unknown) {
  if (process.env.CORRAL_EPIC_EVIDENCE_DIR) await writeFile(join(process.env.CORRAL_EPIC_EVIDENCE_DIR, name), JSON.stringify(data, null, 2))
}

async function read(epicId: string, evidenceName?: string) {
  const response = await t.request('GET', `/api/epics/${epicId}/review`)
  const body = await response.json() as EpicReview & ApiErrorBody
  if (evidenceName) await capture(evidenceName, { request: `GET /api/epics/${epicId}/review`, status: response.status, body })
  return { status: response.status, body }
}

// An epic in human review on `sha`, with a merged task PR the human approved,
// an integrated PR-free task and an approved task nobody human looked at
async function setup(sha = 'head-1') {
  const project = await t.createProject({ defaultBranch: 'develop' })
  await t.db.update(projects).set({ paused: true, requiredChecks: ['lint', 'test'] }).where(eq(projects.id, project.id))
  const branch = `corral/epic-${project.id}`
  t.github.setBranch(project.repository, branch, sha)
  const pr = await t.github.openPullRequest(project.repository, { head: branch, base: 'develop', title: 'Saved searches', body: 'The whole feature' })
  t.github.pullFiles.set(pr.number, [{ path: 'search.ts', status: 'added', additions: 1, deletions: 0, patch: '@@ -0,0 +1 @@\n+a' }])
  const [epic] = await t.db.insert(epics).values({ projectId: project.id, createdBy: t.actor, title: 'Saved searches', description: 'Save a search and reopen it', branch, prNumber: pr.number, prHeadSha: sha, reviewState: 'human_review' }).returning()
  const withPr = await t.createTask(project.slug, { title: 'Search API', epicId: epic!.id, acceptanceCriteria: ['Saves', 'A person likes it'] })
  const prFree = await t.createTask(project.slug, { title: 'Search UI', epicId: epic!.id, acceptanceCriteria: ['Reopens', 'Looks right on a phone'], humanReview: true })
  const agentOnly = await t.createTask(project.slug, { title: 'Search docs', epicId: epic!.id, acceptanceCriteria: ['Documented'] })
  const checked = async (task: Task) => t.db.update(acceptanceCriteria).set({ checkedByHuman: true }).where(eq(acceptanceCriteria.id, task.acceptanceCriteria[1]!.id))
  await checked(withPr)
  await checked(prFree)
  const [agent] = await t.db.select().from(agents).where(eq(agents.role, 'reviewer'))
  const reviewer: Actor = { kind: 'agent', role: 'reviewer', runId: '00000000-0000-4000-8000-000000000000' }
  const passed = async (task: Task, head: string) => {
    const [run] = await t.db.insert(runs).values({ agentId: agent!.id, projectId: project.id, taskId: task.id, role: 'reviewer', state: 'completed', endedAt: new Date() }).returning()
    await t.db.insert(reviews).values({ taskId: task.id, runId: run!.id, round: 0, headSha: head, verdict: 'approved', summary: 'Good', criteria: [{ criterionId: task.acceptanceCriteria[0]!.id, met: true, note: '' }], author: reviewer })
    await t.db.insert(evidence).values({ runId: run!.id, taskId: task.id, criterionId: task.acceptanceCriteria[0]!.id, round: 0, size: 0, kind: 'note', note: `Proof for ${task.title}` })
    await t.db.update(tasks).set({ status: 'merged', headSha: head }).where(eq(tasks.id, task.id))
    return run!
  }
  await passed(withPr, 'task-pr-head')
  await t.db.update(tasks).set({ prNumber: 901, prUrl: 'https://github.com/owner/repo/pull/901' }).where(eq(tasks.id, withPr.id))
  await appendAudit(t.db, { projectId: project.id, taskId: withPr.id, actor: t.actor }, auditEvent('task.transition', { event: 'human_approve', headSha: 'task-pr-head', from: 'human_review', to: 'ready_to_merge' }))
  await passed(prFree, 'free-head')
  await t.db.update(tasks).set({ integrationProtocol: 1 }).where(eq(tasks.id, prFree.id))
  await t.db.insert(taskSubmissions).values({ taskId: prFree.id, sequence: 1, branch: 'free-branch', submittedHeadSha: 'free-head', baseSha: 'free-base', targetBranch: branch, agentApprovedHeadSha: 'free-head', integratedCommitSha: 'free-integrated', integratedAt: new Date() })
  await passed(agentOnly, 'docs-head')
  return { project, epic: epic!, withPr, prFree, agentOnly, sha, branch, agent: agent! }
}

async function requestChanges({ project, epic }: Awaited<ReturnType<typeof setup>>, reviewedSha: string) {
  const [row] = await t.db.select().from(projects).where(eq(projects.id, project.id))
  const id = await createEpicFixTask(t.db, row!, epic, 'Reopen keeps the filters', t.actor)
  const [fix] = await t.db.select().from(tasks).where(eq(tasks.id, id))
  const ref = `${project.prefix}-${fix!.number}`
  await appendAudit(t.db, { projectId: project.id, actor: t.actor }, auditEvent('epic.pr', { epicId: epic.id, event: 'human_changes_requested', headSha: reviewedSha, summary: 'Reopen keeps the filters', fixTasks: [{ id, ref, title: fix!.title }] }))
  await t.db.update(tasks).set({ status: 'merged' }).where(eq(tasks.id, id))
  return { id, ref }
}

it('returns the review with PR, gates, rounds and a row per board task', async () => {
  const s = await setup()
  const { project, epic, withPr, prFree, agentOnly, sha, agent } = s
  const backlog = await t.createTask(project.slug, { title: 'Not on the board yet', epicId: epic.id })
  await t.db.update(tasks).set({ status: 'backlog' }).where(eq(tasks.id, backlog.id))
  t.github.setChecks(sha, [{ name: 'lint', conclusion: 'success', url: 'https://ci/lint' }, { name: 'other', conclusion: 'failure', url: null }])
  const [run] = await t.db.select().from(runs).where(eq(runs.taskId, withPr.id))
  await t.db.insert(epicReviewRounds).values([
    { epicId: epic.id, runId: run!.id, reviewerId: agent.id, round: 1, headSha: 'old', verdict: 'changes_requested', summary: 'Mismatch', findings: [{ level: 'blocking', text: 'Field names differ', taskRefs: [withPr.ref] }] }
  ])
  const [second] = await t.db.select().from(runs).where(eq(runs.taskId, prFree.id))
  await t.db.insert(epicReviewRounds).values({ epicId: epic.id, runId: second!.id, reviewerId: agent.id, round: 2, headSha: sha, verdict: 'approved', summary: 'Works together' })

  const { status, body } = await read(epic.id, 'epic-review-first-round.json')
  expect(status).toBe(200)
  expect(body).toMatchObject({
    epicId: epic.id, title: 'Saved searches', goal: 'Save a search and reopen it', reviewMode: 'epic', state: 'human_review',
    targetBranch: 'develop', headSha: sha, targetMovedBy: 0, seenByHuman: 1, lastFeedback: null, conflictTaskRef: null, mergeCommitSha: null,
    pr: { title: 'Saved searches', body: 'The whole feature', baseBranch: 'develop', totalFiles: 1, truncated: false, files: [{ path: 'search.ts' }] },
    gateChecks: [{ name: 'lint', conclusion: 'success', url: 'https://ci/lint' }, { name: 'test', conclusion: 'missing', url: null }]
  })
  expect(body.rounds.map(r => [r.round, r.verdict, r.findings.length])).toEqual([[2, 'approved', 0], [1, 'changes_requested', 1]])
  expect(body.tasks.map(r => r.ref)).toEqual([withPr.ref, prFree.ref, agentOnly.ref])
  const [api, ui, docs] = body.tasks
  expect(api).toMatchObject({ kind: 'normal', merged: true, reviewedBy: 'human', prNumber: 901, prUrl: 'https://github.com/owner/repo/pull/901', integratedCommit: null, criteriaMet: 2, criteriaTotal: 2, humanReview: false, humanChecks: [] })
  expect(api!.evidence).toMatchObject([{ note: 'Proof for Search API' }])
  expect(ui).toMatchObject({ reviewedBy: 'reviewer', prNumber: null, prUrl: null, integratedCommit: { sha: 'free-integrated' }, criteriaMet: 1, criteriaTotal: 2, humanReview: true, humanChecks: [prFree.acceptanceCriteria[1]!.id] })
  expect(docs).toMatchObject({ reviewedBy: 'reviewer', humanReview: false, humanChecks: [] })
})

it('says how far the target has moved', async () => {
  const { epic, sha } = await setup('head-moved')
  t.github.behind.set(sha, 7)
  const { body } = await read(epic.id, 'epic-review-target-moved.json')
  expect(body.targetMovedBy).toBe(7)
})

it('reports the feedback, its fix tasks and the files since the reviewed head', async () => {
  const s = await setup('head-fixed')
  const { project, epic, sha } = s
  const fix = await requestChanges(s, 'head-reviewed')
  t.github.setComparison('head-reviewed', sha, comparison('head-reviewed', [changed('search.ts', '+fixed')]))
  const { body } = await read(epic.id, 'epic-review-since-last-review.json')
  expect(body.lastFeedback).toMatchObject({
    text: 'Reopen keeps the filters', headSha: 'head-reviewed', fixTasks: [fix], totalFiles: 1, truncated: false,
    files: [{ path: 'search.ts', status: 'modified', additions: 1, patch: '+fixed' }],
    diffUrl: `https://github.com/${project.repository}/compare/head-reviewed...${sha}`
  })
  expect(body.tasks.find(r => r.ref === fix.ref)).toMatchObject({ kind: 'fix' })
})

it('leaves out what a rebase brought in when listing files since the reviewed head', async () => {
  const s = await setup('head-rebased')
  const { epic, sha } = s
  await requestChanges(s, 'head-before')
  const same = changed('same.ts', '+same')
  t.github.setComparison('head-before', sha, comparison('old-base', [same, changed('from-target.ts', '+target')]))
  t.github.setComparison('develop', 'head-before', comparison('old-base', [same, changed('fix.ts', '+v1'), changed('dropped.ts', '+gone')]))
  t.github.setComparison('develop', sha, comparison('new-base', [same, changed('fix.ts', '+v2')]))
  const { body } = await read(epic.id)
  expect(body.lastFeedback!.files.map(f => [f.path, f.status])).toEqual([['fix.ts', 'modified'], ['dropped.ts', 'removed']])
})

it('still answers when GitHub can\'t give the diff, and points at it', async () => {
  const s = await setup('head-unreachable')
  await requestChanges(s, 'head-gone')
  t.github.setComparison('head-gone', s.sha, new GitHubError(404, 'Not Found'))
  const { status, body } = await read(s.epic.id)
  expect(status).toBe(200)
  expect(body.lastFeedback).toMatchObject({ files: [], truncated: true, diffUrl: expect.stringContaining('head-gone...') })
})

it('caps the files since the reviewed head as a PR is capped', async () => {
  const s = await setup('head-big')
  await requestChanges(s, 'head-small')
  t.github.setComparison('head-small', s.sha, comparison('head-small', Array.from({ length: 25 }, (_, i) => changed(`f${i}.ts`, '+x'))))
  const { body } = await read(s.epic.id)
  expect(body.lastFeedback).toMatchObject({ totalFiles: 25, truncated: true })
  expect(body.lastFeedback!.files).toHaveLength(20)
})

it('names the open conflict task', async () => {
  const s = await setup('head-conflict')
  const conflict = await t.createTask(s.project.slug, { title: 'Rebase epic', epicId: s.epic.id })
  await t.db.update(tasks).set({ kind: 'conflict', status: 'ready' }).where(eq(tasks.id, conflict.id))
  expect((await read(s.epic.id)).body.conflictTaskRef).toBe(conflict.ref)
})

it('answers for an epic with no PR yet and for a merged one', async () => {
  const s = await setup('head-merged')
  t.github.behind.set(s.sha, 4)
  await t.db.update(epics).set({ reviewState: 'merged', mergeCommitSha: 'squashed' }).where(eq(epics.id, s.epic.id))
  expect((await read(s.epic.id)).body).toMatchObject({ state: 'merged', targetMovedBy: 0, mergeCommitSha: 'squashed' })
  await t.db.update(epics).set({ reviewState: null, prNumber: null, prHeadSha: null, mergeCommitSha: null }).where(eq(epics.id, s.epic.id))
  expect((await read(s.epic.id)).body).toMatchObject({ pr: null, headSha: null, gateChecks: [{ name: 'lint', conclusion: 'missing' }, { name: 'test', conclusion: 'missing' }] })
})

it('answers 404 for an unknown epic and a clear error for a direct one', async () => {
  const unknown = await read('6eddb30e-f553-4714-8e27-d09c4689a9ef', 'epic-review-unknown.json')
  expect(unknown.status).toBe(404)
  expect(unknown.body.error).toEqual({ code: 'not_found' })
  expect((await read('nonsense')).status).toBe(404)

  const { epic } = await setup('head-direct')
  await t.db.update(epics).set({ reviewMode: 'direct' }).where(eq(epics.id, epic.id))
  const direct = await read(epic.id, 'epic-review-direct.json')
  expect(direct.status).toBe(409)
  expect(direct.body.error).toEqual({ code: 'invalid_input', issues: [{ message: 'This epic merges its tasks straight to the target branch, so it has no epic review' }] })
})
