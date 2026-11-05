import { TASK_INTEGRATION_PROTOCOL, type EpicHistoryEntry, type EpicReviewItem, type Inbox, type RunJob } from '@corral/contracts'
import { schema } from '@corral/db'
import { and, asc, eq, sql } from 'drizzle-orm'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { inspectEpicRebase, prepareEpicRebase, pushEpicRebase } from '../../runner/src/epic-rebase.ts'
import { exec } from '../../runner/src/exec.ts'
import { inspectIntegration, prepareIntegration, pushIntegration } from '../../runner/src/integration.ts'
import { createTestDataDir, TEST_REPOSITORY } from '../../runner/src/test-repo.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { asResolutionTasks } from './test-resolution-task.ts'
import { FakeRunner } from './test-runner.ts'

// The whole mixed workflow (D27): a real server, the real runner git code and a
// real origin, with only the agents and GitHub's PR records played by the test.
// GitHub's merges and branch updates are real git operations here, so what ends
// up on a branch is what the workflow actually produced. Each test gets its own
// database and repository, and `crash` is a restart on the same database.

vi.setConfig({ testTimeout: 60_000 })

type Job = Parameters<FakeRunner['onJob']>[0]
type Task = Awaited<ReturnType<TestApp['createTask']>>
type Project = Awaited<ReturnType<TestApp['createProject']>>

const MODERN = { taskIntegrationProtocols: [TASK_INTEGRATION_PROTOCOL], taskIntegrationExecutor: true, epicRebaseExecutor: true }

let t: TestApp
let runner: FakeRunner
let dataDir: string
let origin: string
let project: Project
let faults: ((job: Job, real: () => Promise<unknown>) => Promise<unknown>) | null
let merged: { number: number, base: string, sha: string }[]

async function git(...args: string[]): Promise<string> {
  const result = await exec('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', '-c', 'core.editor=true', ...args], { cwd: origin })
  if (result.code !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout.trim()
}

const isAncestor = (a: string, b: string) => git('merge-base', '--is-ancestor', a, b).then(() => true, () => false)
const branchExists = (branch: string) => git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).catch(() => null)

async function commitOn(branch: string, file: string, text: string): Promise<string> {
  await git('checkout', '--quiet', branch)
  await writeFile(join(origin, file), text)
  await git('add', '.')
  await git('commit', '--quiet', '-m', `Change ${file}`)
  const head = await git('rev-parse', 'HEAD')
  await git('checkout', '--quiet', 'main')
  return head
}

// GitHub, as far as this workflow can tell, on the real repository
function connectGitHub(): void {
  const { github } = t
  github.branchHead = async (_, branch) => branchExists(branch)
  github.deleteBranch = async (_, branch) => void await git('branch', '-D', branch)
  github.createBranch = async (_, branch, sha) => void await git('branch', branch, sha)
  github.behindBy = async (_, base, head) => Number(await git('rev-list', '--count', `${head}..${base}`))
  github.compare = async (_, base, head) => {
    const mergeBase = await git('merge-base', base, head)
    const names = (await git('diff', '--name-status', '--no-renames', mergeBase, head)).split('\n').filter(Boolean).map(line => line.split('\t') as [string, string])
    const files = await Promise.all(names.map(async ([status, filename]) => ({ filename, status: status === 'A' ? 'added' : status === 'D' ? 'removed' : 'modified', additions: 1, deletions: 0, sha: '', patch: await git('diff', mergeBase, head, '--', filename) })))
    return { mergeBase, files }
  }
  const live = async (branch: string) => github.setBranch(TEST_REPOSITORY, branch, await git('rev-parse', branch))
  const { openPullRequest, getPullRequest, findOpenPullRequest } = github
  github.openPullRequest = async (repository, input) => {
    await live(input.head)
    return openPullRequest.call(github, repository, input)
  }
  github.findOpenPullRequest = async (repository, branch) => {
    await live(branch).catch(() => null)
    return findOpenPullRequest.call(github, repository, branch)
  }
  github.getPullRequest = async (repository, number) => {
    const pr = github.pulls.get(number)
    if (pr && !pr.merged) {
      await live(pr.head)
      pr.mergeableState = await isAncestor(pr.base, pr.head) ? 'clean' : 'behind'
    }
    return getPullRequest.call(github, repository, number)
  }
  github.updateBranch = async (_, { number }, expected) => {
    const pr = github.pulls.get(number)!
    if (await git('rev-parse', pr.head) !== expected) return false
    await git('checkout', '--quiet', pr.head)
    const rebased = await git('rebase', '--quiet', pr.base).then(() => true, async () => {
      await git('rebase', '--abort')
      return false
    })
    await git('checkout', '--quiet', 'main')
    return rebased
  }
  // The squash happens on the base, with the head check GitHub makes
  github.merge = async (_, number, method, expected) => {
    const pr = github.pulls.get(number)!
    if (await git('rev-parse', pr.head) !== expected) return { merged: false, sha: null, message: 'Head branch was modified' }
    await git('checkout', '--quiet', pr.base)
    await git('merge', '--quiet', '--squash', pr.head)
    await git('commit', '--quiet', '-m', `${pr.title} (#${number})`)
    const sha = await git('rev-parse', 'HEAD')
    await git('checkout', '--quiet', 'main')
    Object.assign(pr, { state: 'closed', merged: true, mergeCommitSha: sha })
    merged.push({ number, base: pr.base, sha })
    return { merged: true, sha, message: 'Merged' }
  }
}

async function connectRunner(id = 'r1', capacity: Parameters<typeof FakeRunner.connect>[3] = MODERN): Promise<FakeRunner> {
  const next = await FakeRunner.connect(t.server!.url, [], id, capacity)
  const fallback = next.onJob
  next.onJob = async (job) => {
    const real = async () => {
      switch (job.kind) {
        case 'integration_prepare': return prepareIntegration(dataDir, null, job)
        case 'integration_push': return pushIntegration(dataDir, job)
        case 'integration_inspect': return inspectIntegration(dataDir, job)
        case 'epic_rebase_prepare': return prepareEpicRebase(dataDir, null, job)
        case 'epic_rebase_push': return pushEpicRebase(dataDir, job)
        case 'epic_rebase_inspect': return inspectEpicRebase(dataDir, job)
        default: return fallback(job)
      }
    }
    return (faults ? await faults(job, real) : await real()) as Awaited<ReturnType<FakeRunner['onJob']>>
  }
  return next
}

beforeEach(async () => {
  // An agent running these tests has a push URL that always fails
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  // The process that dies logs the failed writes it attempts
  vi.spyOn(console, 'error').mockImplementation(() => undefined)
  faults = null
  merged = []
  t = await createTestApp('pglite', { listen: true })
  await t.db.update(schema.agents).set({ concurrency: 20, wakeIntervalSeconds: null })
  dataDir = await createTestDataDir()
  origin = join(dirname(dataDir), 'origin')
  project = await t.createProject({ repository: TEST_REPOSITORY })
  connectGitHub()
})
afterEach(async () => {
  faults = null
  runner?.close()
  await t?.close()
  vi.restoreAllMocks()
})

async function capture(name: string, data: unknown) {
  if (process.env.CORRAL_EPIC_EVIDENCE_DIR) await writeFile(join(process.env.CORRAL_EPIC_EVIDENCE_DIR, name), typeof data === 'string' ? data : JSON.stringify(data, null, 2))
}

const tick = () => t.orchestrator.merges.tick()
async function passes(count = 4) {
  for (let n = 0; n < count; n++) await tick()
}
// A pass the epic's backoffs let through: anything that merges goes this way,
// and a test that expects nothing to happen would otherwise prove nothing
async function mergePasses(count: number) {
  for (let n = 0; n < count; n++) await t.mergePass()
}

const taskRow = async (id: string) => (await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!
const epicRow = async (id: string) => (await t.db.select().from(schema.epics).where(eq(schema.epics.id, id)))[0]!
const ops = (epicId: string) => t.db.select().from(schema.taskIntegrationOperations).where(eq(schema.taskIntegrationOperations.epicId, epicId)).orderBy(asc(schema.taskIntegrationOperations.leaseEpoch))
const journal = async (epicId: string) => (await ops(epicId)).map(o => ({ kind: o.kind, state: o.state, error: o.error, expected: o.expectedTargetSha.slice(0, 8), result: o.resultHeadSha?.slice(0, 8) ?? null, resolutionTaskId: o.resolutionTaskId }))
const inbox = async () => (await t.request('GET', '/api/inbox')).json() as Promise<Inbox>
const history = async (epicId: string) => (await t.request('GET', `/api/epics/${epicId}/history`)).json() as Promise<EpicHistoryEntry[]>
const events = async (epicId: string) => (await history(epicId)).map(e => e.event)
const sync = async (epicId: string) => ((await (await t.request('GET', `/api/epics/${epicId}`)).json()) as { sync: unknown }).sync
const log = (range: string) => git('log', '--format=%h %s', range).then(text => text.split('\n').filter(Boolean))
const trailers = async (branch: string, submissionId: string) => (await git('log', '--format=%H', '--fixed-strings', `--grep=Corral-Submission: ${submissionId}`, branch)).split('\n').filter(Boolean)
const submissionsOf = (taskId: string) => t.db.select().from(schema.taskSubmissions).where(eq(schema.taskSubmissions.taskId, taskId))
const taskPrs = (epicBranch: string) => [...t.github.pulls.values()].filter(pr => pr.head !== epicBranch)

async function createEpic(title = 'Saved searches') {
  const [epic] = await t.db.insert(schema.epics).values({ projectId: project.id, createdBy: t.actor, title, reviewMode: 'epic' }).returning()
  return epic!
}

async function createReadyTask(epicId: string, input: Partial<Parameters<TestApp['createTask']>[1]> = {}) {
  const task = await t.createTask(project.slug, { epicId, humanReview: false, ...input })
  expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${task.number}/transitions`, { type: 'approve' })).status).toBe(200)
  return task
}

async function assigned(task: { id: string }, role: RunJob['role']) {
  await t.orchestrator.schedule()
  return (await runner.next('run.assign', m => m.job.taskId === task.id && m.job.role === role)).job
}

// A developer run: real commit on the branch the job names, cut from the job's base
async function develop(task: Task, file: string, text: string, outcome: 'commit_submitted' | 'pr_opened' = 'commit_submitted') {
  const job = await assigned(task, 'developer')
  await git('branch', job.branch!, job.baseBranch!)
  const head = await commitOn(job.branch!, file, text)
  for (const c of task.acceptanceCriteria.filter(c => !c.checkedByHuman)) {
    expect(await runner.call(job.runId, job.leaseEpoch, 'attach_evidence', { criterionId: c.id, kind: 'note', note: `${file} works` })).toMatchObject({ ok: true })
  }
  const base = await git('merge-base', head, job.baseBranch!)
  expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome, note: 'Done', summary: `Adds ${file}`, headSha: head, ...outcome === 'commit_submitted' && { baseSha: base } })).toMatchObject({ ok: true })
  return { job, head }
}

async function review(task: Task, head: string, extra: Record<string, unknown> = { outcome: 'approved' }) {
  const job = await assigned(task, 'reviewer')
  expect(job.headSha).toBe(head)
  expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { summary: 'Checked', headSha: head, criteria: task.acceptanceCriteria.filter(c => !c.checkedByHuman).map(c => ({ criterionId: c.id, met: extra.outcome === 'approved', note: 'Checked' })), ...extra })).toMatchObject({ ok: true })
}

// A PR-free task from Ready to Ready to merge, through agents only
async function deliver(epicId: string, file: string, text = `${file}\n`, input: Partial<Parameters<TestApp['createTask']>[1]> = {}) {
  const task = await createReadyTask(epicId, input)
  const { head } = await develop(task, file, text)
  await review(task, head)
  expect(await taskRow(task.id)).toMatchObject({ status: 'ready_to_merge', integrationProtocol: 1, prNumber: null })
  const [submission] = await submissionsOf(task.id)
  return { ...task, head, submissionId: submission!.id }
}

async function integrationReview(epicId: string) {
  await t.orchestrator.schedule()
  const job = (await runner.next('run.assign', m => m.job.epicId === epicId && m.job.role === 'reviewer')).job
  expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Fits together' })).toMatchObject({ ok: true })
  return job
}

const approveEpic = (epicId: string, headSha: string, confirmed = {}) => t.request('POST', `/api/epics/${epicId}/review`, { action: 'approve', headSha, ...confirmed })

// One PR-free task on the epic branch, reviewed and approved by the human, with
// CI required so the merge waits on the test
async function humanApprovedEpic(file = 'feature.txt', text = 'feature\n') {
  const epic = await createEpic()
  const task = await deliver(epic.id, file, text)
  await passes(1)
  expect(await taskRow(task.id)).toMatchObject({ status: 'merged' })
  await t.db.update(schema.projects).set({ requiredChecks: ['ci'] }).where(eq(schema.projects.id, project.id))
  await integrationReview(epic.id)
  const { prHeadSha, branch } = await epicRow(epic.id)
  expect((await approveEpic(epic.id, prHeadSha!)).status).toBe(200)
  return { ...epic, branch: branch!, head: prHeadSha!, task }
}

const passCi = (sha: string) => t.github.setChecks(sha, [{ name: 'ci', conclusion: 'success', url: null }])

// The process dies with `kind` under way: if `land`, the job's work reached the
// remote, but either way no answer ever arrives. A new process then starts on
// the same database and the same runner connects to it.
async function crashDuring(kind: Job['kind'], land: boolean, pass: () => Promise<unknown> = t.mergePass) {
  const { promise: died, resolve } = Promise.withResolvers<void>()
  faults = async (job, real) => {
    if (job.kind !== kind) return real()
    faults = null
    if (land) await real()
    resolve()
    return new Promise(() => undefined)
  }
  void pass().catch(() => null)
  await died
  await restart()
}

async function restart() {
  const old = runner
  await t.restart()
  old.close()
  runner = await connectRunner()
}

it('lands a feature of several PR-free tasks through one parent PR and one human approval', async () => {
  runner = await connectRunner()
  const epic = await createEpic()
  const human = { text: 'Works on a real phone', checkedByHuman: true }
  const a = await deliver(epic.id, 'api.txt')
  const b = await deliver(epic.id, 'ui.txt', 'ui\n', { humanReview: true })
  const c = await deliver(epic.id, 'docs.txt', 'docs\n', { acceptanceCriteria: ['Documented', human] })
  const before = await git('rev-parse', 'main')

  await Promise.all([tick(), tick()])
  await passes(2)
  const branch = (await epicRow(epic.id)).branch!
  for (const task of [a, b, c]) {
    const [commit, ...extra] = await trailers(branch, task.submissionId)
    expect(extra).toEqual([])
    expect(await taskRow(task.id)).toMatchObject({ status: 'merged', mergeCommitSha: commit })
  }
  expect((await inbox()).needsYou).toEqual([])
  expect(await git('rev-parse', 'main')).toBe(before)

  // Every board task is in: one PR, however often the pass runs
  await t.orchestrator.schedule()
  await t.orchestrator.schedule()
  expect(await taskPrs(branch)).toEqual([])
  expect(t.github.pulls.size).toBe(1)
  expect([...t.github.pulls.values()][0]).toMatchObject({ head: branch, base: 'main', state: 'open' })
  await mergePasses(2)
  expect(await git('rev-parse', 'main')).toBe(before)

  await integrationReview(epic.id)
  await mergePasses(2)
  expect(await git('rev-parse', 'main')).toBe(before)
  const needsYou = (await inbox()).needsYou
  expect(needsYou.map(i => [i.type, i.id])).toEqual([['epic_review', epic.id]])
  const item = needsYou[0] as EpicReviewItem
  expect(item.tasks.map(entry => entry.task.pr)).toEqual([null, null, null])
  expect(item.tasks.map(entry => entry.task.submission?.integrated?.sha)).toEqual(await Promise.all([a, b, c].map(async task => (await taskRow(task.id)).mergeCommitSha)))

  // The tasks' human obligations are confirmed on this one approval
  const refused = await approveEpic(epic.id, item.headSha)
  expect(refused.status).toBe(409)
  expect(await refused.json()).toMatchObject({ error: { constraint: 'human_checks_unconfirmed' } })
  const check = c.acceptanceCriteria.find(x => x.checkedByHuman)!
  expect((await approveEpic(epic.id, item.headSha, { confirmedTasks: [b.id], confirmedCriteria: [check.id] })).status).toBe(200)
  expect((await approveEpic(epic.id, item.headSha, { confirmedTasks: [b.id], confirmedCriteria: [check.id] })).status).toBe(409)
  await t.mergePass()

  expect(await epicRow(epic.id)).toMatchObject({ reviewState: 'merged', mergeCommitSha: await git('rev-parse', 'main') })
  expect(await git('rev-list', '--count', `${before}..main`)).toBe('1')
  expect((await git('ls-tree', '--name-only', 'main')).split('\n')).toEqual(expect.arrayContaining(['api.txt', 'ui.txt', 'docs.txt']))
  expect(merged).toHaveLength(1)
  expect((await events(epic.id)).filter(e => e === 'human_approved')).toHaveLength(1)
  expect((await events(epic.id)).filter(e => e === 'opened')).toHaveLength(1)
  expect(await branchExists(branch)).toBeNull()
  await capture('one-feature-pr.json', {
    scenario: 'Three PR-free tasks, one flagged humanReview and one with a human check, delivered by agents and integrated by two concurrent passes.',
    pullRequests: [...t.github.pulls.values()].map(pr => ({ number: pr.number, head: pr.head, base: pr.base, state: pr.state, merged: pr.merged })),
    taskPrs: 0,
    needsYouDuringFeature: needsYou.map(i => ({ type: i.type, subject: i.subject })),
    approvalWithoutConfirmingObligations: { status: refused.status, constraint: 'human_checks_unconfirmed' },
    commitsAddedToTarget: await log(`${before}..main`),
    filesOnTarget: (await git('ls-tree', '--name-only', 'main')).split('\n'),
    epicHistory: (await history(epic.id)).map(e => `${e.actor}: ${e.text}`)
  })
})

it('completes a parent task mixing a grandfathered task PR with a PR-free task, keeping both contributions and their evidence', async () => {
  // Before the upgrade: a runner that only knows task PRs opens one on the epic
  runner = await connectRunner('r1', {})
  const epic = await createEpic()
  const legacy = await createReadyTask(epic.id, { acceptanceCriteria: ['The API answers'] })
  const { head: legacyHead } = await develop(legacy, 'legacy.txt', 'legacy\n', 'pr_opened')
  const opened = await taskRow(legacy.id)
  expect(opened).toMatchObject({ integrationProtocol: 0, status: 'agent_review', prNumber: expect.any(Number) })
  const { prNumber, prUrl, branch: legacyBranch } = opened

  // The runner is upgraded with that PR still open. Nothing converts it.
  runner.close()
  runner = await connectRunner()
  await review(legacy, legacyHead, { outcome: 'changes_requested' })
  const revision = await assigned(legacy, 'developer')
  const legacyRevision = await commitOn(legacyBranch!, 'legacy.txt', 'legacy, revised\n')
  await runner.call(revision.runId, revision.leaseEpoch, 'attach_evidence', { criterionId: legacy.acceptanceCriteria[0]!.id, kind: 'note', note: 'Revised and checked' })
  expect(await runner.call(revision.runId, revision.leaseEpoch, 'report_outcome', { outcome: 'commit_submitted', note: 'Done', summary: 'Revised', headSha: legacyRevision, baseSha: 'x' })).toMatchObject({ ok: false })
  expect(await runner.call(revision.runId, revision.leaseEpoch, 'report_outcome', { outcome: 'pr_updated', note: 'Done', summary: 'Revised', headSha: legacyRevision })).toMatchObject({ ok: true })
  expect(await taskRow(legacy.id)).toMatchObject({ integrationProtocol: 0, prNumber, prUrl })
  expect(await submissionsOf(legacy.id)).toEqual([])

  // A new task in the same epic takes the PR-free path, and the target moves,
  // so the epic is rebased under the open task PR
  const fresh = await deliver(epic.id, 'fresh.txt', 'fresh\n', { acceptanceCriteria: ['The UI works'] })
  const landed = await commitOn('main', 'elsewhere.txt', 'other team\n')
  await passes(1)
  expect(await taskRow(fresh.id)).toMatchObject({ status: 'merged', prNumber: null })
  const branch = (await epicRow(epic.id)).branch!
  expect(await isAncestor(landed, branch)).toBe(true)
  expect(t.github.pulls.get(prNumber!)).toMatchObject({ state: 'open', merged: false, base: branch })

  await review(legacy, legacyRevision)
  await passes(4)
  const finished = await taskRow(legacy.id)
  expect(finished).toMatchObject({ status: 'merged', integrationProtocol: 0, prNumber, prUrl, mergeCommitSha: expect.any(String) })
  expect(merged.map(m => [m.number, m.base])).toEqual([[prNumber, branch]])
  expect(t.github.calls.filter(c => c.method === 'closePullRequest')).toEqual([])

  await integrationReview(epic.id)
  const item = (await inbox()).needsYou.find(i => i.id === epic.id) as EpicReviewItem
  const [one, two] = item.tasks
  expect(one).toMatchObject({ task: { id: legacy.id, pr: { number: prNumber, url: prUrl }, submission: null } })
  expect(two).toMatchObject({ task: { id: fresh.id, pr: null, submission: { sequence: 1, submitted: { sha: fresh.head }, approved: { sha: fresh.head }, integrated: { sha: (await taskRow(fresh.id)).mergeCommitSha } } } })
  // Each round's evidence is still there, for both
  expect(one!.evidence.map(e => e.note)).toEqual(expect.arrayContaining(['legacy.txt works', 'Revised and checked']))
  expect(two!.evidence.map(e => e.note)).toEqual(['fresh.txt works'])

  const before = await git('rev-parse', 'main')
  expect((await approveEpic(epic.id, item.headSha)).status).toBe(200)
  await t.mergePass()
  expect((await epicRow(epic.id)).reviewState).toBe('merged')
  expect(await git('rev-list', '--count', `${before}..main`)).toBe('1')
  expect(await git('show', 'main:legacy.txt')).toBe('legacy, revised')
  expect(await git('show', 'main:fresh.txt')).toBe('fresh')
  expect(await git('show', 'main:elsewhere.txt')).toBe('other team')
  await capture('mixed-epic.json', {
    scenario: 'A task PR opened by a legacy runner stays open through a runner upgrade, a revision and a parent task rebase; a new task in the same parent goes PR-free.',
    legacyTask: { protocol: 0, status: finished.status, pr: { number: prNumber, url: prUrl, state: t.github.pulls.get(prNumber!)!.state, merged: t.github.pulls.get(prNumber!)!.merged }, closedByRollout: 0, submissions: 0, evidence: one!.evidence.map(e => e.note) },
    prFreeTask: { protocol: 1, status: 'merged', pr: null, submission: two!.task.submission, evidence: two!.evidence.map(e => e.note) },
    commitsOnTargetAfterMerge: await log(`${landed}~1..main`),
    filesOnTarget: (await git('ls-tree', '--name-only', 'main')).split('\n'),
    epicHistory: (await history(epic.id)).map(e => `${e.actor}: ${e.text}`)
  })
})

it('keeps PR-free tasks off a legacy runner, tells it why, and carries on once an executor connects', async () => {
  runner = await connectRunner()
  const epic = await createEpic()
  const task = await deliver(epic.id, 'waiting.txt')

  // Only an old build is left: approved work waits, and nothing counts as failed
  runner.close()
  await vi.waitFor(() => expect(t.runner.online).toBe(false), { timeout: 5000 })
  runner = await connectRunner('old', {})
  const pending = await t.createTask(project.slug, { epicId: epic.id, humanReview: false })
  await t.db.update(schema.tasks).set({ integrationProtocol: 1 }).where(eq(schema.tasks.id, pending.id))
  expect((await t.request('POST', `/api/projects/${project.slug}/tasks/${pending.number}/transitions`, { type: 'approve' })).status).toBe(200)
  await t.orchestrator.schedule()
  await passes(2)
  expect(await taskRow(task.id)).toMatchObject({ status: 'ready_to_merge' })
  expect(await taskRow(pending.id)).toMatchObject({ status: 'ready', leaseRunId: null })
  expect(await ops(epic.id)).toEqual([])
  const status = await (await t.request('GET', '/api/runner')).json() as { runners: { id: string, online: boolean, integrationCompatibilityReason: string | null }[] }
  const old = status.runners.find(r => r.id === 'old')!
  expect(old.integrationCompatibilityReason).toContain('Update the runner')

  runner.close()
  await vi.waitFor(() => expect(t.runner.online).toBe(false), { timeout: 5000 })
  runner = await connectRunner()
  await passes(1)
  expect(await taskRow(task.id)).toMatchObject({ status: 'merged' })
  await capture('legacy-runner.json', { request: { method: 'GET', url: '/api/runner' }, response: old, approvedTaskWhileNoExecutor: 'ready_to_merge', pendingPrFreeTaskOnLegacyRunner: 'ready, unleased', operationsStarted: 0, afterExecutorConnected: 'merged' })
})

describe('restarting during an integration', () => {
  it.for([
    { kind: 'integration_prepare', land: false, title: 'while preparing' },
    { kind: 'integration_prepare', land: true, title: 'after preparing, with the answer lost' },
    { kind: 'integration_push', land: false, title: 'as the push starts' },
    { kind: 'integration_push', land: true, title: 'after the push landed, with the answer lost' }
  ] as const)('recovers $title: one commit, nothing lost', async ({ kind, land, title }) => {
    runner = await connectRunner()
    const epic = await createEpic()
    const earlier = await deliver(epic.id, 'earlier.txt')
    await passes(1)
    const task = await deliver(epic.id, 'task.txt')
    const branch = (await epicRow(epic.id)).branch!

    await crashDuring(kind, land)
    expect(await taskRow(task.id)).toMatchObject({ status: 'ready_to_merge', mergedAt: null })
    const atCrash = await journal(epic.id)
    await passes()

    const [commit, ...extra] = await trailers(branch, task.submissionId)
    expect(extra).toEqual([])
    expect(await trailers(branch, earlier.submissionId)).toHaveLength(1)
    expect(await taskRow(task.id)).toMatchObject({ status: 'merged', mergeCommitSha: commit })
    expect((await submissionsOf(task.id))[0]).toMatchObject({ integratedCommitSha: commit, agentApprovedHeadSha: task.head })
    expect(await git('show', `${branch}:task.txt`)).toBe('task.txt')
    expect((await ops(epic.id)).filter(o => o.state === 'succeeded')).toHaveLength(2)
    await capture(`restart-integration-${kind}-${land ? 'landed' : 'unsent'}.json`, { scenario: `The server dies ${title}.`, journalAtCrash: atCrash, journalAfterRecovery: await journal(epic.id), epicLog: await log(branch), taskStatus: 'merged', commitsCarryingThisSubmission: 1 })
  })
})

describe('restarting during an epic rebase', () => {
  it.for([
    { kind: 'epic_rebase_prepare', land: false, title: 'while preparing' },
    { kind: 'epic_rebase_prepare', land: true, title: 'after preparing, with the answer lost' },
    { kind: 'epic_rebase_push', land: false, title: 'as the push starts' },
    { kind: 'epic_rebase_push', land: true, title: 'after the push landed, with the answer lost' }
  ] as const)('recovers $title and keeps the approval it earned, on the new head', async ({ kind, land, title }) => {
    runner = await connectRunner()
    const epic = await humanApprovedEpic()
    const onto = await commitOn('main', 'target.txt', 'target\n')

    await crashDuring(kind, land)
    const atCrash = await journal(epic.id)
    expect((await approveEpic(epic.id, epic.head)).status).toBe(409)
    // A push with no result counts as a failed attempt, which waits a minute
    await passes(1)
    t.clock.now = new Date(t.clock.now.getTime() + 120_000)
    await passes()

    const head = await git('rev-parse', epic.branch)
    expect(await isAncestor(onto, head)).toBe(true)
    expect(head).not.toBe(epic.head)
    expect(await git('rev-list', '--count', `${onto}..${epic.branch}`)).toBe('1')
    expect(await trailers(epic.branch, epic.task.submissionId)).toHaveLength(1)
    expect((await ops(epic.id)).filter(o => o.kind === 'rebase' && o.state === 'succeeded')).toHaveLength(1)
    expect(await epicRow(epic.id)).toMatchObject({ reviewState: 'ready_to_merge', prHeadSha: head, approvedHeadSha: epic.head, approvedBaseSha: onto })
    expect((await events(epic.id)).filter(e => e === 'approval_retained')).toHaveLength(1)

    // Approval never stands in for the gates on the new head
    passCi(epic.head)
    await mergePasses(2)
    expect(merged).toEqual([])
    passCi(head)
    await t.mergePass()
    expect((await epicRow(epic.id)).reviewState).toBe('merged')
    expect(await git('show', 'main:feature.txt')).toBe('feature')
    expect(await git('show', 'main:target.txt')).toBe('target')
    await capture(`restart-rebase-${kind}-${land ? 'landed' : 'unsent'}.json`, { scenario: `The server dies ${title}. The parent was human-approved before the target moved.`, journalAtCrash: atCrash, humanApprovingOldHeadDuringRecovery: 409, journalAfterRecovery: await journal(epic.id), approval: { approvedHeadSha: epic.head.slice(0, 8), carriedTo: head.slice(0, 8) }, mergedOnlyAfterCiOnNewHead: true, commitsOnTarget: await log('main') })
  })

  it('grants no approval to a head that moved while the server was down', async () => {
    runner = await connectRunner()
    const epic = await humanApprovedEpic()
    const onto = await commitOn('main', 'target.txt', 'target\n')
    await crashDuring('epic_rebase_push', true)
    const rebased = await git('rev-parse', epic.branch)
    const outsider = await commitOn(epic.branch, 'outsider.txt', 'not reviewed\n')
    passCi(outsider)

    await passes(1)
    await t.orchestrator.schedule()
    expect((await ops(epic.id)).at(-1)).toMatchObject({ kind: 'rebase', state: 'failed', error: 'The parent branch moved', resultHeadSha: rebased })
    const after = await epicRow(epic.id)
    expect(after).toMatchObject({ reviewState: 'in_review', approvedHeadSha: null, approvedBaseSha: null, prHeadSha: outsider })
    await mergePasses(2)
    expect(merged).toEqual([])
    expect((await approveEpic(epic.id, outsider)).status).toBe(409)
    expect(await events(epic.id)).toContain('approval_invalidated')

    await integrationReview(epic.id)
    expect((await approveEpic(epic.id, epic.head)).status).toBe(409)
    expect((await approveEpic(epic.id, outsider)).status).toBe(200)
    await t.mergePass()
    expect((await epicRow(epic.id)).reviewState).toBe('merged')
    expect(await isAncestor(onto, 'main')).toBe(true)
    expect(await git('show', 'main:outsider.txt')).toBe('not reviewed')
    await capture('restart-stale-approval.json', { scenario: 'A rebase push landed, the server died, and someone pushed to the parent branch before it came back.', journal: await journal(epic.id), approvalAfterRestart: { reviewState: after.reviewState, approvedHeadSha: after.approvedHeadSha, prHeadSha: outsider.slice(0, 8) }, mergesBeforeNewReview: 0, staleHumanApproval: 409, history: (await history(epic.id)).map(e => `${e.actor}: ${e.text}`) })
  })

  it('refuses the verdict of an integration review cut off by a restart', async () => {
    runner = await connectRunner()
    const epic = await createEpic()
    await deliver(epic.id, 'feature.txt')
    await passes(1)
    await t.orchestrator.schedule()
    const stale = (await runner.next('run.assign', m => m.job.epicId === epic.id && m.job.role === 'reviewer')).job

    await restart()
    const verdict = await runner.call(stale.runId, stale.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'From before the crash' })
    expect(verdict).toMatchObject({ ok: false })
    expect(await epicRow(epic.id)).toMatchObject({ reviewState: 'in_review', approvedHeadSha: null })
    expect((await inbox()).needsYou).toEqual([])

    const again = await integrationReview(epic.id)
    expect(again.runId).not.toBe(stale.runId)
    expect((await epicRow(epic.id)).reviewState).toBe('human_review')
  })
})

// The epic and target changed the same file. A developer rebases the candidate
// the conflict task names, as `git rebase` and an edit would.
async function conflictedResolution(epic: { id: string }, onto: string, file: string, text: string) {
  await mergePasses(1)
  await asResolutionTasks(t.db, t.github)
  const operation = (await ops(epic.id)).filter(o => o.kind === 'rebase').at(-1)
  const fix = await taskRow(operation!.resolutionTaskId!)
  await git('checkout', '--quiet', fix.branch!)
  await git('rebase', onto).catch(() => null)
  await writeFile(join(origin, file), text)
  await git('add', '.')
  await git('rebase', '--continue')
  const resolved = await git('rev-parse', 'HEAD')
  await git('checkout', '--quiet', 'main')
  const criteria = await t.db.select().from(schema.acceptanceCriteria).where(eq(schema.acceptanceCriteria.taskId, fix.id))
  return { operation: operation!, fix, resolved, criteria }
}

async function resolutionSubmits(fix: { id: string }, criteria: { id: string }[], head: string) {
  const dev = await assigned(fix, 'developer')
  expect(dev).toMatchObject({ checkScope: 'none' })
  expect(dev.prompt).toContain('run no lint, typecheck, tests, build or check scripts')
  expect(dev.prompt).not.toContain('Squash the branch')
  for (const c of criteria) await runner.call(dev.runId, dev.leaseEpoch, 'attach_evidence', { criterionId: c.id, kind: 'note', note: 'Kept both sides' })
  expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'pr_updated', note: 'Resolved', summary: 'Rebased', headSha: head })).toMatchObject({ ok: true })
}

async function resolutionApproved(fix: { id: string }, criteria: { id: string }[], head: string, preservesApproval: boolean) {
  const job = await assigned(fix, 'reviewer')
  expect(job.headSha).toBe(head)
  expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Both sides kept', criteria: criteria.map(c => ({ criterionId: c.id, met: true, note: '' })), preservesApproval })).toMatchObject({ ok: true })
}

const decision = {
  question: 'Should exports keep filtering?',
  bindingDecision: 'D31 changed on the target',
  alternatives: [
    { label: 'Keep filtering', effect: 'Stays as approved', changesBehaviour: false },
    { label: 'Follow the target', effect: 'Exports every row', changesBehaviour: true }
  ],
  affectedChanges: ['target: export everything', 'parent: filtered exports']
}

describe('a conflict before approval (COR-445)', () => {
  const FIXES = { ...MODERN, epicFixExecutor: true }
  const rebases = async (epicId: string) => (await ops(epicId)).filter(o => o.kind === 'rebase')
  const fixRuns = (epicId: string) => t.db.select().from(schema.runs).where(and(eq(schema.runs.epicId, epicId), eq(schema.runs.role, 'developer')))

  // An epic with a task on its branch and another held back, so no review
  // starts until the test has moved the target
  async function heldEpic(file: string, text: string) {
    const epic = await createEpic()
    const held = await createReadyTask(epic.id)
    await t.db.update(schema.tasks).set({ paused: true }).where(eq(schema.tasks.id, held.id))
    const task = await deliver(epic.id, file, text)
    await passes(1)
    expect(await taskRow(task.id)).toMatchObject({ status: 'merged' })
    return { ...epic, branch: (await epicRow(epic.id)).branch!, held }
  }

  async function finishHeld({ held }: { held: Task }, file: string) {
    await t.db.update(schema.tasks).set({ paused: false }).where(eq(schema.tasks.id, held.id))
    const { head } = await develop(held, file, `${file}\n`)
    await review(held, head)
    await passes(2)
    expect(await taskRow(held.id)).toMatchObject({ status: 'merged' })
    await t.db.update(schema.projects).set({ requiredChecks: ['ci'] }).where(eq(schema.projects.id, project.id))
  }

  async function approveAtHead(epicId: string) {
    const { prHeadSha, reviewState } = await epicRow(epicId)
    expect(reviewState).toBe('human_review')
    expect((await approveEpic(epicId, prHeadSha!)).status).toBe(200)
  }

  async function fixJob(epicId: string) {
    await t.orchestrator.schedule()
    return (await runner.next('run.assign', m => m.job.epicId === epicId && m.job.role === 'developer')).job
  }

  async function resolveOn(branch: string, onto: string, file: string, text: string) {
    await git('checkout', '--quiet', branch)
    await git('rebase', onto).catch(() => null)
    await writeFile(join(origin, file), text)
    await git('add', '.')
    await git('rebase', '--continue')
    const resolved = await git('rev-parse', 'HEAD')
    await git('checkout', '--quiet', 'main')
    return resolved
  }

  async function reportFix(job: RunJob, headSha: string, file: string, behaviourChanged = false) {
    expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_updated', summary: 'Kept both sides', note: 'Resolved', headSha, behaviourChanged, conflictedFiles: [file] })).toMatchObject({ ok: true })
    await mergePasses(1)
  }

  it('carries on through integration and review, and resolves once after approval across two target moves', async () => {
    runner = await connectRunner('r1', FIXES)
    const epic = await heldEpic('shared.txt', 'epic\n')
    await commitOn('main', 'shared.txt', 'target\n')
    // The rebase at this integration conflicts, and the task lands anyway
    await finishHeld(epic, 'more.txt')

    expect((await rebases(epic.id)).at(-1)).toMatchObject({ state: 'failed', conflictFiles: ['shared.txt'], fix: null })
    expect(await sync(epic.id)).toEqual({ state: 'conflict_pending', files: ['shared.txt'] })
    expect((await inbox()).needsYou).toEqual([])
    expect(await events(epic.id)).toContain('conflict_deferred')
    // The same commits aren't tried again
    const tried = (await rebases(epic.id)).length
    await passes(2)
    expect(await rebases(epic.id)).toHaveLength(tried)

    await integrationReview(epic.id)
    const onto = await commitOn('main', 'other.txt', 'second move\n')
    await mergePasses(2)
    expect((await rebases(epic.id)).at(-1)).toMatchObject({ state: 'failed', ontoSha: onto })
    expect(await epicRow(epic.id)).toMatchObject({ reviewState: 'human_review' })
    expect(await fixRuns(epic.id)).toEqual([])

    await approveAtHead(epic.id)
    await mergePasses(2)
    expect(await epicRow(epic.id)).toMatchObject({ reviewState: 'ready_to_merge' })
    const active = (await rebases(epic.id)).at(-1)!
    expect(active).toMatchObject({ state: 'running', fix: 'conflict', conflictFiles: ['shared.txt'] })
    expect(await sync(epic.id)).toMatchObject({ state: 'fixing', fix: 'conflict' })

    const job = await fixJob(epic.id)
    const resolved = await resolveOn(job.branch!, active.ontoSha!, 'shared.txt', 'target\nepic\n')
    await reportFix(job, resolved, 'shared.txt')
    expect(await epicRow(epic.id)).toMatchObject({ reviewState: 'ready_to_merge', prHeadSha: resolved, mergeCommitSha: null })
    expect(await sync(epic.id)).toBeNull()

    passCi(resolved)
    await t.mergePass()
    expect((await epicRow(epic.id)).reviewState).toBe('merged')
    expect(await git('show', 'main:shared.txt')).toBe('target\nepic')
    expect(await fixRuns(epic.id)).toHaveLength(1)
    expect((await events(epic.id)).filter(e => e === 'fix_started')).toHaveLength(1)
    expect((await inbox()).needsYou).toEqual([])
  })

  it('waits for a rebase when the target moves during the merge, and counts no refused merge', async () => {
    runner = await connectRunner('r1', FIXES)
    const epic = await humanApprovedEpic()
    passCi(epic.head)
    const { merge } = t.github
    let merges = 0
    t.github.merge = async (...args) => {
      merges++
      return merge.apply(t.github, args)
    }
    const { checks } = t.github
    t.github.checks = async (...args) => {
      await commitOn('main', `moved-${merges}.txt`, 'moved\n')
      t.github.checks = checks
      return checks.apply(t.github, args)
    }
    await t.mergePass()
    t.github.merge = merge
    expect(merges).toBe(0)
    expect(await events(epic.id)).not.toContain('merge_refused')
    expect((await epicRow(epic.id)).reviewState).toBe('ready_to_merge')
  })

  it('clears the pending conflict when a later checkpoint rebases cleanly', async () => {
    runner = await connectRunner('r1', FIXES)
    const epic = await heldEpic('shared.txt', 'epic\n')
    await commitOn('main', 'shared.txt', 'target\n')
    await finishHeld(epic, 'more.txt')
    expect(await sync(epic.id)).toMatchObject({ state: 'conflict_pending' })

    await git('rm', '--quiet', 'shared.txt')
    await git('commit', '--quiet', '-m', 'Target drops its version')
    await mergePasses(2)

    expect((await rebases(epic.id)).at(-1)).toMatchObject({ state: 'succeeded' })
    expect(await sync(epic.id)).toBeNull()
    expect(await fixRuns(epic.id)).toEqual([])
  })

  it('sends a second conflict during final resolution the same way, and never merges it unresolved', async () => {
    runner = await connectRunner('r1', FIXES)
    const epic = await heldEpic('shared.txt', 'epic\n')
    await commitOn('main', 'shared.txt', 'target\n')
    await finishHeld(epic, 'more.txt')
    await integrationReview(epic.id)
    await approveAtHead(epic.id)
    await mergePasses(2)

    const job = await fixJob(epic.id)
    const active = (await rebases(epic.id)).at(-1)!
    const resolved = await resolveOn(job.branch!, active.ontoSha!, 'shared.txt', 'target\nepic\n')
    await commitOn('main', 'shared.txt', 'target again\n')
    await reportFix(job, resolved, 'shared.txt')
    passCi(resolved)
    await mergePasses(2)

    expect((await epicRow(epic.id)).reviewState).toBe('ready_to_merge')
    const second = (await rebases(epic.id)).at(-1)!
    expect(second).toMatchObject({ state: 'running', fix: 'conflict', expectedTargetSha: resolved })

    const again = await fixJob(epic.id)
    const final = await resolveOn(again.branch!, second.ontoSha!, 'shared.txt', 'target again\nepic\n')
    await reportFix(again, final, 'shared.txt')
    expect((await epicRow(epic.id)).reviewState).toBe('ready_to_merge')
    passCi(final)
    await t.mergePass()
    expect((await epicRow(epic.id)).reviewState).toBe('merged')
    expect(await git('show', 'main:shared.txt')).toBe('target again\nepic')
    expect(await fixRuns(epic.id)).toHaveLength(2)
  })

  it('returns the parent through review and the human when approval cannot carry', async () => {
    runner = await connectRunner('r1', FIXES)
    const epic = await heldEpic('shared.txt', 'epic\n')
    await commitOn('main', 'shared.txt', 'target\n')
    await finishHeld(epic, 'more.txt')
    await integrationReview(epic.id)
    await approveAtHead(epic.id)
    await mergePasses(2)

    const job = await fixJob(epic.id)
    const resolved = await resolveOn(job.branch!, (await rebases(epic.id)).at(-1)!.ontoSha!, 'shared.txt', 'merged differently\n')
    await reportFix(job, resolved, 'shared.txt', true)
    expect(await epicRow(epic.id)).toMatchObject({ reviewState: 'open', approvedHeadSha: null })

    await mergePasses(1)
    await integrationReview(epic.id)
    await approveAtHead(epic.id)
    passCi(resolved)
    await t.mergePass()
    expect((await epicRow(epic.id)).reviewState).toBe('merged')
    expect(await fixRuns(epic.id)).toHaveLength(1)
  })
})

describe('a target update that conflicts', () => {
  it('finishes a routine conflict with no human, keeping the approval', async () => {
    runner = await connectRunner()
    const epic = await humanApprovedEpic('shared.txt', 'epic\n')
    const onto = await commitOn('main', 'shared.txt', 'target\n')

    const { fix, resolved, criteria, operation } = await conflictedResolution(epic, onto, 'shared.txt', 'target\nepic\n')
    expect(await sync(epic.id)).toMatchObject({ state: 'resolving', files: ['shared.txt'], taskId: fix.id })
    expect((await inbox()).needsYou).toEqual([])
    await resolutionSubmits(fix, criteria, resolved)
    expect(await git('rev-parse', epic.branch)).toBe(epic.head)
    await resolutionApproved(fix, criteria, resolved, true)
    await tick()

    expect(await git('rev-parse', epic.branch)).toBe(resolved)
    expect(await taskRow(fix.id)).toMatchObject({ status: 'merged' })
    expect(await epicRow(epic.id)).toMatchObject({ reviewState: 'ready_to_merge', prHeadSha: resolved, approvedHeadSha: epic.head, approvedBaseSha: onto })
    expect((await inbox()).needsYou).toEqual([])
    passCi(resolved)
    await t.mergePass()
    expect((await epicRow(epic.id)).reviewState).toBe('merged')
    expect(await git('show', 'main:shared.txt')).toBe('target\nepic')
    expect((await events(epic.id)).filter(e => e === 'human_approved')).toHaveLength(1)
    await capture('routine-conflict.json', { scenario: 'The target changed a file a human-approved parent also changed.', humanStepsAfterTheTargetMoved: 0, needsYouThroughout: [], operation: { id: operation.id, state: 'succeeded', conflictFiles: operation.conflictFiles }, resolutionTask: { title: fix.title, branch: fix.branch, status: 'merged' }, fileOnTarget: await git('show', 'main:shared.txt'), history: (await history(epic.id)).map(e => `${e.actor}: ${e.text}`) })
  })

  it('waits for the human on a behaviour decision, with its context, then goes back through review', async () => {
    runner = await connectRunner()
    const epic = await humanApprovedEpic('shared.txt', 'filtered\n')
    const onto = await commitOn('main', 'shared.txt', 'everything\n')
    const { fix, resolved, criteria, operation } = await conflictedResolution(epic, onto, 'shared.txt', 'everything\nwith a total\n')

    const dev = await assigned(fix, 'developer')
    expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'stuck', note: 'Needs a decision', summary: 'The two sides disagree', decision })).toMatchObject({ ok: true })

    // It waits, with the lock held and nothing moved, however long it's left
    await mergePasses(3)
    await t.orchestrator.schedule()
    const recovery = (await taskRow(fix.id)).retryStop!
    expect(recovery.sessionId).toEqual(expect.any(String))
    expect((await inbox()).needsYou).toEqual([])
    const pm = (await runner.next('run.assign', m => m.job.planSessionId === recovery.sessionId)).job
    expect(await runner.call(pm.runId, pm.leaseEpoch, 'get_task', { taskRef: `${project.prefix}-${fix.number}` })).toMatchObject({ ok: true })
    const question = `Blocked: the target changed a binding decision; both behaviours cannot stand. Decision needed: ${decision.question}`
    expect(await runner.call(pm.runId, pm.leaseEpoch, 'ask_question', { question, recommendation: 'Follow the target', options: decision.alternatives.map(a => a.label), retryOptions: decision.alternatives.map(a => a.label) })).toMatchObject({ ok: true })
    runner.send({ type: 'run.events', runId: pm.runId, leaseEpoch: pm.leaseEpoch, events: [{ type: 'message', text: 'This binding decision needs human authority.' }] })
    runner.send({ type: 'run.ended', runId: pm.runId, leaseEpoch: pm.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
    await expect.poll(async () => (await t.db.select().from(schema.runs).where(eq(schema.runs.id, pm.runId)))[0]!.state).toBe('completed')
    const needsYou = (await inbox()).needsYou
    expect(needsYou).toMatchObject([{ id: recovery.sessionId, type: 'plan_thread', status: 'question', question: { text: question, recommendation: 'Follow the target' } }])
    const waiting = await sync(epic.id)
    expect(waiting).toMatchObject({ state: 'deciding', question: decision.question, taskId: fix.id })
    // What the operator guide's journal query shows for it
    const inventory = await t.db.execute(sql.raw(await readFile(join(import.meta.dirname, '../../../docs/operations/epic-operations.sql'), 'utf8'))) as unknown as { rows: Record<string, unknown>[] }
    const operatorView = inventory.rows
    expect(operatorView).toMatchObject([{ kind: 'rebase', state: 'running', epic: epic.title, conflict_files: ['shared.txt'], task: `${project.prefix}-${fix.number}` }])
    expect(await git('rev-parse', epic.branch)).toBe(epic.head)
    expect(merged).toEqual([])
    await capture('behaviour-decision.json', { scenario: 'The target changed behaviour the parent relies on, so both can\'t stand.', request: { method: 'GET', url: '/api/inbox' }, needsYouItem: needsYou[0], epicSync: waiting, operatorJournalQuery: operatorView, epicBranchMoved: false, targetLanded: false })

    expect((await t.request('POST', `/api/plan/sessions/${recovery.sessionId}/messages`, { text: 'Follow the target' })).status).toBe(201)
    const recorded = (await ops(epic.id)).find(o => o.id === operation.id)!.decisions[0]!.answer
    expect(recorded).toMatchObject({ alternative: 1, label: 'Follow the target', changesBehaviour: true })
    const continuation = (await runner.next('run.assign', m => m.job.planSessionId === recovery.sessionId)).job
    runner.send({ type: 'run.events', runId: continuation.runId, leaseEpoch: continuation.leaseEpoch, events: [{ type: 'message', text: 'The decision is recorded; work can resume.' }] })
    runner.send({ type: 'run.ended', runId: continuation.runId, leaseEpoch: continuation.leaseEpoch, exit: { kind: 'exited', code: 0 }, headSha: null })
    expect(await taskRow(fix.id)).toMatchObject({ status: 'in_progress' })
    expect((await ops(epic.id)).filter(o => o.kind === 'rebase').map(o => [o.id, o.state])).toEqual([[operation.id, 'running']])

    await resolutionSubmits(fix, criteria, resolved)
    await resolutionApproved(fix, criteria, resolved, true)
    await tick()
    expect(await epicRow(epic.id)).toMatchObject({ approvedHeadSha: null, reviewState: expect.stringMatching(/open|in_review/) })
    expect(await events(epic.id)).toContain('approval_invalidated')

    await integrationReview(epic.id)
    expect((await inbox()).needsYou.map(i => i.id)).toEqual([epic.id])
    expect((await approveEpic(epic.id, resolved)).status).toBe(200)
    passCi(resolved)
    await t.mergePass()
    expect((await epicRow(epic.id)).reviewState).toBe('merged')
    expect(await git('show', 'main:shared.txt')).toBe('everything\nwith a total')
    expect((await events(epic.id)).filter(e => e === 'human_approved')).toHaveLength(2)
  })

  it.for([
    { land: false, title: 'as its push starts' },
    { land: true, title: 'after its push landed' }
  ])('publishes a reviewed resolution once when the server dies $title', async ({ land, title }) => {
    runner = await connectRunner()
    const epic = await humanApprovedEpic('shared.txt', 'epic\n')
    const onto = await commitOn('main', 'shared.txt', 'target\n')
    const { fix, resolved, criteria } = await conflictedResolution(epic, onto, 'shared.txt', 'target\nepic\n')
    await resolutionSubmits(fix, criteria, resolved)
    await resolutionApproved(fix, criteria, resolved, true)

    await crashDuring('epic_rebase_push', land)
    await passes(3)

    expect(await git('rev-parse', epic.branch)).toBe(resolved)
    expect(await git('rev-list', '--count', `${onto}..${epic.branch}`)).toBe('1')
    expect(await taskRow(fix.id)).toMatchObject({ status: 'merged', mergeCommitSha: resolved })
    expect((await ops(epic.id)).filter(o => o.kind === 'rebase').map(o => o.state)).toEqual(['succeeded'])
    expect(await epicRow(epic.id)).toMatchObject({ prHeadSha: resolved, approvedHeadSha: epic.head })
    await capture(`restart-resolution-${land ? 'landed' : 'unsent'}.json`, { scenario: `The server dies ${title}, with the resolution reviewed.`, journal: await journal(epic.id), epicHeadIsTheReviewedCommit: true, approvalKeptFromReview: true })
  })

  // The epic loosens a type both sides edited, and a test only the target added
  // reads it, so the rebase can't typecheck without editing that test
  const READER = 'first\nconst mine = i.project.id\nlast\n'
  const ADAPTED = 'first\nconst mine = i.project?.id\nlast\n'

  async function adaptedResolution(epic: { id: string }, onto: string) {
    const conflict = await conflictedResolution(epic, onto, 'types.txt', 'label: string\nproject: Project | null\n')
    const adapted = await commitOn(conflict.fix.branch!, 'reader.test.txt', ADAPTED)
    return { ...conflict, adapted }
  }

  it('publishes an edit to a target-only file only once its reviewer has seen and approved it', async () => {
    runner = await connectRunner()
    const epic = await humanApprovedEpic('types.txt', 'project: Project | null\n')
    await commitOn('main', 'reader.test.txt', READER)
    const onto = await commitOn('main', 'types.txt', 'label: string\nproject: Project\n')
    const { fix, criteria, adapted } = await adaptedResolution(epic, onto)
    await resolutionSubmits(fix, criteria, adapted)

    // The first reviewer turns it down: nothing moves, and it goes back
    const refused = await assigned(fix, 'reviewer')
    expect(refused.prompt).toContain('## Files only the target changed')
    expect(refused.prompt).toContain('- `reader.test.txt`')
    expect(refused.prompt).toContain('-const mine = i.project.id')
    expect(refused.prompt).toContain('+const mine = i.project?.id')
    expect(refused.prompt).toContain('preservesApproval: false')
    expect(refused.prompt).not.toContain('### `types.txt`')
    await capture('target-file-review-prompt.md', refused.prompt)
    expect(await runner.call(refused.runId, refused.leaseEpoch, 'report_outcome', { outcome: 'changes_requested', summary: 'Dropped the target work', headSha: adapted, criteria: criteria.map(c => ({ criterionId: c.id, met: false, note: 'No' })) })).toMatchObject({ ok: true })
    await mergePasses(2)
    expect(await git('rev-parse', epic.branch)).toBe(epic.head)
    expect(await taskRow(fix.id)).toMatchObject({ status: 'in_progress', mergedAt: null })

    await resolutionSubmits(fix, criteria, adapted)
    await resolutionApproved(fix, criteria, adapted, false)
    await tick()

    expect(await git('rev-parse', epic.branch)).toBe(adapted)
    expect(await taskRow(fix.id)).toMatchObject({ status: 'merged' })
    expect(await git('diff', onto, epic.branch, '--name-only')).toBe('reader.test.txt\ntypes.txt')
    expect(await git('show', `${epic.branch}:reader.test.txt`)).toBe(ADAPTED.trim())
    expect(await epicRow(epic.id)).toMatchObject({ approvedHeadSha: null, reviewState: expect.stringMatching(/open|in_review/) })
    expect(await events(epic.id)).toContain('approval_invalidated')

    await integrationReview(epic.id)
    expect((await approveEpic(epic.id, adapted)).status).toBe(200)
    passCi(adapted)
    await t.mergePass()
    expect((await epicRow(epic.id)).reviewState).toBe('merged')
    expect(await git('show', 'main:reader.test.txt')).toBe(ADAPTED.trim())
  })

  it('drops approval for a target-only edit even when the reviewer says it preserves approval', async () => {
    runner = await connectRunner()
    const epic = await humanApprovedEpic('types.txt', 'project: Project | null\n')
    await commitOn('main', 'reader.test.txt', READER)
    const onto = await commitOn('main', 'types.txt', 'label: string\nproject: Project\n')
    const { fix, criteria, adapted } = await adaptedResolution(epic, onto)
    await resolutionSubmits(fix, criteria, adapted)
    await resolutionApproved(fix, criteria, adapted, true)
    await tick()

    expect(await git('rev-parse', epic.branch)).toBe(adapted)
    expect(await taskRow(fix.id)).toMatchObject({ status: 'merged' })
    const operation = (await ops(epic.id)).find(o => o.kind === 'rebase')!
    expect(operation.resolutionReview).toMatchObject({ headSha: adapted, preserved: true, outsideConflicts: ['reader.test.txt'] })
    expect(await epicRow(epic.id)).toMatchObject({ approvedHeadSha: null, reviewState: expect.stringMatching(/open|in_review/) })
    expect(await events(epic.id)).toContain('approval_invalidated')
    const entries = await history(epic.id)
    expect(entries.some(e => e.text.includes('The resolution changed files outside the conflicts: reader.test.txt.'))).toBe(true)
    await capture('target-file-approval-invalidated.json', { scenario: 'The reviewer approves a target-only adaptation with preservesApproval true; the server independently drops the old approval.', journal: await journal(epic.id), epic: await epicRow(epic.id), history: entries })
  })

  it('starts over on the current target when a resolution has failed and the target moved', async () => {
    runner = await connectRunner()
    const epic = await humanApprovedEpic('types.txt', 'project: Project | null\n')
    await commitOn('main', 'reader.test.txt', READER)
    const stale = await commitOn('main', 'types.txt', 'label: string\nproject: Project\n')
    const { fix, operation } = await conflictedResolution(epic, stale, 'types.txt', 'label: string\nproject: Project | null\n')
    for (let run = 0; run < 3; run++) {
      const dev = await assigned(fix, 'developer')
      expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'failed', note: 'No way through', summary: 'The gates and the guard disagree' })).toMatchObject({ ok: true })
    }
    expect(await taskRow(fix.id)).toMatchObject({ status: 'failed' })

    // On the same commits it waits for a human, who can still retry it
    await mergePasses(2)
    expect((await ops(epic.id)).filter(o => o.kind === 'rebase').map(o => o.state)).toEqual(['running'])
    expect(await taskRow(fix.id)).toMatchObject({ status: 'failed', deletedAt: null })

    const current = await commitOn('main', 'later.txt', 'later\n')
    await mergePasses(2)
    const [old, fresh] = (await ops(epic.id)).filter(o => o.kind === 'rebase')
    expect(old).toMatchObject({ id: operation.id, state: 'failed' })
    expect(fresh).toMatchObject({ state: 'running', ontoSha: current, expectedTargetSha: epic.head })
    expect((await taskRow(fix.id)).deletedAt).not.toBeNull()
    expect(await branchExists(fix.branch!)).toBeNull()
    expect((await epicRow(epic.id)).syncError).toBeNull()

    const { fix: next, criteria, adapted } = await adaptedResolution(epic, current)
    expect(next.id).not.toBe(fix.id)
    await resolutionSubmits(next, criteria, adapted)
    await resolutionApproved(next, criteria, adapted, false)
    await tick()
    expect(await git('rev-parse', epic.branch)).toBe(adapted)
    expect(await isAncestor(current, epic.branch)).toBe(true)
    expect(await epicRow(epic.id)).toMatchObject({ approvedHeadSha: null, reviewState: expect.stringMatching(/open|in_review/) })
    await integrationReview(epic.id)
    expect((await inbox()).needsYou.map(i => i.id)).toEqual([epic.id])
    await capture('failed-resolution-recovery.json', { scenario: 'A resolution hit the failed-run cap holding the writer lock, then the target moved.', journal: await journal(epic.id), epicReviewState: (await epicRow(epic.id)).reviewState, approvedHeadSha: (await epicRow(epic.id)).approvedHeadSha, readerFile: await git('show', `${epic.branch}:reader.test.txt`), targetVersion: await git('show', 'main:reader.test.txt'), history: (await history(epic.id)).map(e => `${e.actor}: ${e.text}`) })
  })

  it('keeps one operation and one task when the server restarts while a resolution is under way', async () => {
    runner = await connectRunner()
    const epic = await humanApprovedEpic('shared.txt', 'epic\n')
    const onto = await commitOn('main', 'shared.txt', 'target\n')
    const { fix, resolved, criteria, operation } = await conflictedResolution(epic, onto, 'shared.txt', 'target\nepic\n')

    await restart()
    await passes(2)
    expect((await ops(epic.id)).filter(o => o.kind === 'rebase').map(o => [o.id, o.state])).toEqual([[operation.id, 'running']])
    expect((await t.db.select().from(schema.tasks).where(eq(schema.tasks.branch, fix.branch!))).map(row => row.id)).toEqual([fix.id])

    await resolutionSubmits(fix, criteria, resolved)
    await resolutionApproved(fix, criteria, resolved, false)
    await tick()
    expect(await git('rev-parse', epic.branch)).toBe(resolved)
    expect(await epicRow(epic.id)).toMatchObject({ approvedHeadSha: null, reviewState: expect.stringMatching(/open|in_review/) })
  })
})

it('keeps simultaneous integrations on two parent tasks whole while the target advances under them', async () => {
  runner = await connectRunner()
  const first = await createEpic('First')
  const second = await createEpic('Second')
  const tasks = [
    await deliver(first.id, 'first-a.txt'), await deliver(second.id, 'second-a.txt'),
    await deliver(first.id, 'first-b.txt'), await deliver(second.id, 'second-b.txt')
  ]
  const live = new Map<string, number>()
  let most = 0
  let advanced = 0
  let target = Promise.resolve()
  const landed: string[] = []
  faults = async (job, real) => {
    const branch = 'targetBranch' in job && job.kind.startsWith('integration') ? job.targetBranch : 'epicBranch' in job ? job.epicBranch : null
    if (!branch) return real()
    live.set(branch, (live.get(branch) ?? 0) + 1)
    most = Math.max(most, live.get(branch)!)
    try {
      // The target moves under the first jobs of the run
      if (advanced < 2) {
        const file = `target-${++advanced}.txt`
        target = target.then(async () => void landed.push(await commitOn('main', file, 'target\n')))
        await target
      }
      return await real()
    } finally {
      live.set(branch, live.get(branch)! - 1)
    }
  }
  await Promise.all([tick(), tick(), tick()])
  await passes(3)

  expect(most).toBe(1)
  for (const task of tasks) expect(await taskRow(task.id)).toMatchObject({ status: 'merged' })
  for (const { epic, own, other } of [{ epic: first, own: tasks.filter((_, n) => n % 2 === 0), other: 'second-a.txt' }, { epic: second, own: tasks.filter((_, n) => n % 2 === 1), other: 'first-a.txt' }]) {
    const branch = (await epicRow(epic.id)).branch!
    for (const task of own) expect(await trailers(branch, task.submissionId)).toHaveLength(1)
    expect(await git('rev-list', '--merges', `main..${branch}`)).toBe('')
    expect((await git('ls-tree', '--name-only', branch)).split('\n')).not.toContain(other)
  }

  // Each is brought up to the target before its review, and lands on its own
  for (const epic of [first, second]) {
    await tick()
    await integrationReview(epic.id)
    await tick()
    const { prHeadSha } = await epicRow(epic.id)
    expect((await approveEpic(epic.id, prHeadSha!)).status).toBe(200)
    await mergePasses(2)
    expect((await epicRow(epic.id)).reviewState).toBe('merged')
  }
  for (const sha of landed) expect(await isAncestor(sha, 'main')).toBe(true)
  expect((await git('ls-tree', '--name-only', 'main')).split('\n')).toEqual(expect.arrayContaining(['first-a.txt', 'first-b.txt', 'second-a.txt', 'second-b.txt', 'target-1.txt', 'target-2.txt']))
  expect(merged).toHaveLength(2)
  await capture('simultaneous-epics.json', { scenario: 'Three concurrent passes over two parent tasks with four approved tasks, with the target moving under the jobs.', mostConcurrentWritersOnOneEpicBranch: most, journals: { first: await journal(first.id), second: await journal(second.id) }, commitsOnTarget: await log('main') })
})
