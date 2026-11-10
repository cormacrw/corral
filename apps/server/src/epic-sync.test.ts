import { schema } from '@corral/db'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, onTestFinished, vi } from 'vitest'
import { inspectEpicRebase, prepareEpicRebase, pushEpicRebase } from '../../runner/src/epic-rebase.ts'
import { exec } from '../../runner/src/exec.ts'
import { GitHubError } from './github.ts'
import { inspectIntegration, prepareIntegration, pushIntegration } from '../../runner/src/integration.ts'
import { createTestDataDir, TEST_REPOSITORY } from '../../runner/src/test-repo.ts'
import { readAudit } from './audit.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './fake-runner.ts'
import { recordTaskSubmission } from './task-submissions.ts'

// Real git processes, so these need more time than the default on a busy machine
vi.setConfig({ testTimeout: 30_000 })

// The real runner git code against a real origin, with the real server deciding.
type Job = Parameters<FakeRunner['onJob']>[0]
let faults: ((job: Job, real: () => Promise<unknown>) => Promise<unknown>) | null = null

let t: TestApp
let runner: FakeRunner
let dataDir: string
let origin: string
let project: Awaited<ReturnType<TestApp['createProject']>>
let branches = 0
let priorEpicIds = new Set<string>()

async function git(...args: string[]): Promise<string> {
  const result = await exec('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], { cwd: origin })
  if (result.code !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

beforeAll(async () => {
  t = await createTestApp('pglite', { listen: true })
  await t.db.update(schema.agents).set({ concurrency: 20, wakeIntervalSeconds: null })
  dataDir = await createTestDataDir()
  origin = join(dirname(dataDir), 'origin')
  project = await t.createProject({ repository: TEST_REPOSITORY })
  t.github.branchHead = async (_, branch) => git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).catch(() => null)
  t.github.deleteBranch = async (_, branch) => void await git('branch', '-D', branch)
  t.github.createBranch = async (_, branch, sha) => void await git('branch', branch, sha).catch(() => null)
  // PRs stay fake, but their heads are the real branch's
  const live = async (branch: string) => t.github.setBranch(TEST_REPOSITORY, branch, await git('rev-parse', branch))
  const { openPullRequest, getPullRequest, findOpenPullRequest } = t.github
  t.github.openPullRequest = async (repository, input) => {
    await live(input.head)
    return openPullRequest.call(t.github, repository, input)
  }
  t.github.findOpenPullRequest = async (repository, branch) => {
    await live(branch).catch(() => null)
    return findOpenPullRequest.call(t.github, repository, branch)
  }
  t.github.getPullRequest = async (repository, number) => {
    const pr = t.github.pulls.get(number)
    if (pr && !pr.merged) await live(pr.head)
    return getPullRequest.call(t.github, repository, number)
  }
  t.github.behindBy = async (_, base, head) => Number(await git('rev-list', '--count', `${head}..${base}`))
  t.github.compare = async (_, base, head) => {
    const mergeBase = await git('merge-base', base, head)
    const names = (await git('diff', '--name-status', '--no-renames', mergeBase, head)).split('\n').filter(Boolean).map(line => line.split('\t') as [string, string])
    const files = await Promise.all(names.map(async ([status, filename]) => ({ filename, status: status === 'A' ? 'added' : status === 'D' ? 'removed' : 'modified', additions: 1, deletions: 0, sha: '', patch: await git('diff', mergeBase, head, '--', filename) })))
    return { mergeBase, files }
  }
  runner = await FakeRunner.connect(t.server!.url)
  const fallback = runner.onJob
  runner.onJob = async (job) => {
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
})
afterAll(async () => {
  runner?.close()
  await t?.close()
})
beforeEach(async () => {
  priorEpicIds = new Set((await t.db.select({ id: schema.epics.id }).from(schema.epics)).map(e => e.id))
  // An agent running these tests has a push URL that always fails
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  faults = null
  t.orchestrator.gate.stopped = false
  await t.db.update(schema.projects).set({ paused: false }).where(eq(schema.projects.id, project.id))
  // Earlier tests' work must not fill the runner's slots
  await t.orchestrator.controls.stopAll(t.actor).catch(() => null)
  await t.orchestrator.controls.resumeAll(t.actor).catch(() => null)
  t.orchestrator.gate.stopped = false
  await t.db.update(schema.tasks).set({ status: 'blocked', statusReason: 'Done with', leaseRunId: null, leaseRole: null, leaseExpiresAt: null, leaseHeartbeatAt: null }).where(inArray(schema.tasks.status, ['ready_to_merge', 'ready', 'in_progress', 'agent_review']))
  // Nor may their epics, which would claim reviewers and rebase on every pass
  await t.db.update(schema.epics).set({ reviewState: 'merged' })
  await t.db.update(schema.runs).set({ state: 'interrupted', endedAt: new Date() }).where(isNotNull(schema.runs.epicId))
  await git('checkout', '--quiet', '--force', 'main')
})

// Optional evidence records the API's responses, not assertion or gate output.
afterEach(async () => {
  if (!process.env.CORRAL_EPIC_EVIDENCE_DIR) return
  const fresh = (await t.db.select().from(schema.epics)).filter(e => !priorEpicIds.has(e.id))
  const responses = []
  for (const epic of fresh) {
    for (const path of [`/api/epics/${epic.id}`, `/api/epics/${epic.id}/history`]) {
      const response = await fetch(`${t.server!.url}${path}`)
      responses.push({ method: 'GET', path, status: response.status, body: await response.json() })
    }
  }
  const response = await fetch(`${t.server!.url}/api/runs`)
  const allRuns = await response.json() as { epicId: string | null }[]
  responses.push({ method: 'GET', path: '/api/runs', status: response.status, body: allRuns.filter(r => fresh.some(e => e.id === r.epicId)) })
  await capture(`${expect.getState().currentTestName!.replace(/[^a-z0-9]+/gi, '-').slice(-150)}.json`, { scenario: expect.getState().currentTestName, transport: 'HTTP on isolated server; real git; fixture GitHub PRs and checks', responses })
})

async function capture(name: string, data: unknown) {
  if (process.env.CORRAL_EPIC_EVIDENCE_DIR) await writeFile(join(process.env.CORRAL_EPIC_EVIDENCE_DIR, name), JSON.stringify(data, null, 2))
}

async function captureEpic(name: string, epicId: string, extra: Record<string, unknown> = {}) {
  if (!process.env.CORRAL_EPIC_EVIDENCE_DIR) return
  const responses = []
  for (const path of [`/api/epics/${epicId}`, `/api/epics/${epicId}/history`, '/api/runs']) {
    const response = await fetch(`${t.server!.url}${path}`)
    const body = await response.json() as unknown
    responses.push({ method: 'GET', path, status: response.status, body: path === '/api/runs' ? (body as { epicId: string | null }[]).filter(r => r.epicId === epicId) : body })
  }
  await capture(name, { ...extra, responses })
}

const journal = async (epicId: string) => (await ops(epicId)).map(o => ({ kind: o.kind, state: o.state, expectedEpicHead: o.expectedTargetSha, ontoSha: o.ontoSha, result: o.resultHeadSha, fix: o.fix, conflictFiles: o.conflictFiles, error: o.error }))

async function commitOn(branch: string, file: string, text: string): Promise<string> {
  await git('checkout', '--quiet', branch)
  await writeFile(join(origin, file), text)
  await git('add', '.')
  await git('commit', '--quiet', '-m', `Change ${file}`)
  const head = await git('rev-parse', 'HEAD')
  await git('checkout', '--quiet', 'main')
  return head
}

// An epic with `shared.txt` on main and the epic's own version of it
async function createEpic(values: Partial<typeof schema.epics.$inferInsert> = {}) {
  const file = `shared-${++branches}.txt`
  await commitOn('main', file, 'line\n')
  const branch = `epic-${branches}`
  await git('branch', branch, 'main')
  const [epic] = await t.db.insert(schema.epics).values({ projectId: project.id, createdBy: t.actor, title: 'Feature', reviewMode: 'epic', branch, ...values }).returning()
  const head = await commitOn(branch, `${branch}.txt`, 'task work\n')
  return { ...epic!, branch, head, file }
}

// A task in Ready to merge, approved on its own branch
async function approved(epic: { id: string, branch: string }, file: string) {
  const branch = `task-${++branches}`
  await git('branch', branch, epic.branch)
  const base = await git('rev-parse', epic.branch)
  const head = await commitOn(branch, file, `${file}\n`)
  const task = await t.createTask(project.slug, { epicId: epic.id, humanReview: false })
  await t.db.update(schema.tasks).set({ branch, integrationProtocol: 1 }).where(eq(schema.tasks.id, task.id))
  const submission = await recordTaskSubmission(t.db, { taskId: task.id, submittedHeadSha: head, baseSha: base })
  await t.db.update(schema.taskSubmissions).set({ agentApprovedHeadSha: head }).where(eq(schema.taskSubmissions.id, submission.id))
  await t.db.update(schema.tasks).set({ status: 'ready_to_merge', headSha: head }).where(eq(schema.tasks.id, task.id))
  return task
}

const tick = () => t.orchestrator.mergePass()
const ops = (epicId: string) => t.db.select().from(schema.taskIntegrationOperations).where(eq(schema.taskIntegrationOperations.epicId, epicId)).orderBy(schema.taskIntegrationOperations.leaseEpoch)
const reload = async (id: string) => (await t.db.select().from(schema.epics).where(eq(schema.epics.id, id)))[0]!
const epicApi = async (id: string) => (await t.request('GET', `/api/epics/${id}`)).json() as Promise<{ sync: unknown, reviewState: string | null }>
const taskRow = async (id: string) => (await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!
const isAncestor = (a: string, b: string) => git('merge-base', '--is-ancestor', a, b).then(() => true, () => false)
const needsYou = async (id: string) => ((await (await t.request('GET', '/api/inbox')).json()) as { needsYou: { id: string, epicId?: string, type?: string, stopped?: { error: string, fix: string | null } }[] }).needsYou.filter(i => i.epicId === id || i.id === id)

// Target and epic both change `file`, so the rebase can only conflict
async function conflicted() {
  const epic = await createEpic()
  await commitOn(epic.branch, epic.file, 'task version\n')
  const head = await git('rev-parse', epic.branch)
  const onto = await commitOn('main', epic.file, 'target version\n')
  const done = await t.createTask(project.slug, { epicId: epic.id, humanReview: false })
  await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, done.id))
  return { ...epic, head, onto, done }
}

// Has the developer do the rebase in a clone-free way: on the candidate branch
async function resolve(branch: string, onto: string, file: string, text: string): Promise<string> {
  await git('checkout', '--quiet', branch)
  await exec('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'rebase', onto], { cwd: origin })
  await writeFile(join(origin, file), text)
  await git('add', '.')
  await exec('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', '-c', 'core.editor=true', 'rebase', '--continue'], { cwd: origin })
  const head = await git('rev-parse', 'HEAD')
  await git('checkout', '--quiet', 'main')
  return head
}

it('rebases an active task at the next task integration, with no hand-off and no task PR', async () => {
  const epic = await createEpic()
  const landed = await commitOn('main', 'landed.txt', 'from another team\n')
  const task = await approved(epic, 'a.txt')
  await tick()

  expect(await taskRow(task.id)).toMatchObject({ status: 'merged' })
  const head = await git('rev-parse', epic.branch)
  expect(await isAncestor(landed, head)).toBe(true)
  expect((await git('ls-tree', '--name-only', epic.branch)).split('\n')).toEqual(expect.arrayContaining(['landed.txt', 'a.txt', `${epic.branch}.txt`]))
  expect(await git('rev-list', '--merges', `main..${epic.branch}`)).toBe('')
  expect((await ops(epic.id)).map(o => [o.kind, o.state])).toEqual([['rebase', 'succeeded'], ['integrate', 'succeeded']])
  expect([...t.github.pulls.values()].filter(pr => pr.head.startsWith('task-'))).toEqual([])
  expect(await needsYou(epic.id)).toEqual([])
  await capture('sync-at-integration.json', { scenario: 'Target advanced, then a task integrated. No API call was made to start the rebase.', targetCommitThatLanded: landed, epicLog: (await git('log', '--oneline', '--format=%h %s', `${landed}~1..${epic.branch}`)).split('\n'), operations: await journal(epic.id), taskStatus: (await taskRow(task.id)).status, taskPrs: 0, inboxNeedsYou: await needsYou(epic.id) })
})

it('synchronizes when the target renamed a file the task edited', async () => {
  const epic = await createEpic()
  const lines = 'one\ntwo\nthree\nfour\nfive\nsix\n'
  const file = `renamed-${++branches}`
  await commitOn('main', `${file}.txt`, lines)
  await git('branch', '--force', epic.branch, 'main')
  const head = await commitOn(epic.branch, `${file}.txt`, `${lines}epic\n`)
  await git('mv', `${file}.txt`, `${file}-moved.txt`)
  await git('commit', '--quiet', '-m', 'Rename it')
  const task = await approved(epic, `${file}-task.txt`)
  await tick()

  const rebased = await git('rev-parse', epic.branch)
  expect(await taskRow(task.id)).toMatchObject({ status: 'merged' })
  expect(await git('show', `${rebased}:${file}-moved.txt`)).toContain('epic')
  expect((await epicApi(epic.id)).sync).toBeNull()
  await capture('target-renamed-epic-file.json', { scenario: 'The task edited a file and the target renamed it. One merge pass later:', epicHeadBefore: head, epicHeadAfter: rebased, renamedFileOnEpic: await git('show', `${rebased}:${file}-moved.txt`), taskStatus: 'merged', operations: await journal(epic.id), inboxNeedsYou: await needsYou(epic.id) })
})

it('rebases before review, and keeps approval over a clean rebase before merge', async () => {
  const epic = await createEpic({ prNumber: null })
  const task = await t.createTask(project.slug, { epicId: epic.id })
  await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, task.id))
  await commitOn('main', 'before-review.txt', 'x\n')

  await t.orchestrator.scheduler.schedule() // held: behind its target
  expect((await reload(epic.id)).reviewState).toBeNull()
  await tick()
  await t.orchestrator.scheduler.schedule()
  const review = (await runner.next('run.assign', m => m.job.epicId === epic.id)).job
  expect(review.headSha).toBe(await git('rev-parse', epic.branch))
  expect(await isAncestor('main', review.headSha!)).toBe(true)
  expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Fits' })).toMatchObject({ ok: true })

  // Target moves while the human reads: the head follows and approval stands
  await commitOn('main', 'before-merge.txt', 'x\n')
  await t.mergePass()
  const head = await git('rev-parse', epic.branch)
  expect(head).not.toBe(review.headSha)
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'human_review', prHeadSha: head })
  await t.orchestrator.scheduler.schedule()
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'human_review', prHeadSha: head })
  expect(await needsYou(epic.id)).toHaveLength(1)
  expect(await t.db.select().from(schema.runs).where(eq(schema.runs.epicId, epic.id))).toHaveLength(1)

  expect((await t.request('POST', `/api/epics/${epic.id}/review`, { action: 'approve', headSha: head })).status).toBe(200)
  await commitOn('main', 'just-before-merge.txt', 'x\n')
  await t.mergePass()
  await t.mergePass()
  const final = await reload(epic.id)
  expect(final.reviewState).toBe('merged')
  expect(t.github.calls.filter(c => c.method === 'updateBranch')).toEqual([])
})

it('keeps task integration off the task\'s branch while a fix holds the lock', async () => {
  const epic = await humanApproved(await conflicted())
  await tick()
  const task = await approved(epic, 'late.txt')
  await tick()
  await tick()
  expect(await taskRow(task.id)).toMatchObject({ status: 'ready_to_merge' })
  expect(await git('rev-parse', epic.branch)).toBe(epic.head)
  expect((await ops(epic.id)).map(o => o.kind)).toEqual(['rebase'])
  // The database refuses a second writer whichever kind it is
  const [submission] = await t.db.select().from(schema.taskSubmissions).where(eq(schema.taskSubmissions.taskId, task.id))
  const refused = await t.db.insert(schema.taskIntegrationOperations).values({ submissionId: submission!.id, epicId: epic.id, kind: 'integrate', expectedTargetSha: epic.head, leaseEpoch: 9 }).then(() => null, (error: Error) => error.cause instanceof Error ? error.cause.message : error.message)
  expect(refused).not.toBeNull()
  await capture('writer-lock.json', { scenario: 'A conflict fix holds the lock; a task reaches Ready to merge; two passes run; then a second operation is inserted directly.', taskStatusAfterTwoPasses: (await taskRow(task.id)).status, epicBranchHeadUnchanged: await git('rev-parse', epic.branch) === epic.head, operations: await journal(epic.id), directInsertRefusedBy: refused })
})

it('never pushes over a write that beat the rebase to the branch', async () => {
  const epic = await createEpic()
  await commitOn('main', `x-${++branches}.txt`, 'x\n')
  await approved(epic, 'a.txt')
  faults = async (job, real) => {
    if (job.kind === 'epic_rebase_push') {
      faults = null
      await commitOn(epic.branch, 'sneaked.txt', 'x\n')
    }
    return real()
  }
  await tick()
  await tick()
  expect((await git('ls-tree', '--name-only', epic.branch)).split('\n')).toContain('sneaked.txt')
  expect((await ops(epic.id))[0]).toMatchObject({ kind: 'rebase', state: 'failed', error: 'The task\'s branch moved' })
  await capture('compare-and-swap.json', { scenario: 'A commit reached the task\'s branch just before the rebase push.', racedCommitKept: (await git('ls-tree', '--name-only', epic.branch)).includes('sneaked.txt'), operations: await journal(epic.id) })
  expect(await isAncestor('main', await git('rev-parse', epic.branch))).toBe(true)
})

it('writes nothing while paused or stopped, and resumes afterwards', async () => {
  const epic = await createEpic()
  await commitOn('main', `x-${++branches}.txt`, 'x\n')
  await approved(epic, 'a.txt')
  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  await tick()
  expect(await git('rev-parse', epic.branch)).toBe(epic.head)
  expect(await ops(epic.id)).toEqual([])
  await t.db.update(schema.projects).set({ paused: false }).where(eq(schema.projects.id, project.id))

  // The kill switch lands between building the candidate and pushing it
  faults = async (job, real) => {
    if (job.kind === 'epic_rebase_prepare') {
      t.orchestrator.gate.stopped = true
    }
    return real()
  }
  await tick().catch(() => null)
  await t.orchestrator.mergePass()
  const sent: string[] = []
  faults = async (job, real) => {
    sent.push(job.kind)
    return real()
  }
  // The pass that was running saw `stopped` before it pushed
  expect(await git('rev-parse', epic.branch)).toBe(epic.head)
  expect((await ops(epic.id))[0]).toMatchObject({ state: 'running' })
  t.orchestrator.gate.stopped = false
  await tick()
  expect(sent).toContain('epic_rebase_push')
  await capture('pause-and-stop.json', { paused: { operationsStarted: 0, epicBranchMoved: false }, killSwitchBetweenPrepareAndPush: { operationState: 'running', epicBranchMoved: false }, afterResume: { jobsSent: sent, epicBranchMoved: true } })
  expect(await isAncestor('main', await git('rev-parse', epic.branch))).toBe(true)
})

it('holds a candidate when the project is paused while it was being prepared', async () => {
  const epic = await createEpic()
  await commitOn('main', `x-${++branches}.txt`, 'x\n')
  await approved(epic, 'a.txt')
  faults = async (job, real) => {
    if (job.kind === 'epic_rebase_prepare') await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
    return real()
  }
  const sent: string[] = []
  await tick()
  faults = async (job, real) => {
    sent.push(job.kind)
    return real()
  }
  await tick()
  expect(await git('rev-parse', epic.branch)).toBe(epic.head)
  expect(sent).toEqual([])
  const held = await journal(epic.id)
  expect(held[0]).toMatchObject({ state: 'running', result: expect.any(String) })

  await t.db.update(schema.projects).set({ paused: false }).where(eq(schema.projects.id, project.id))
  await tick()
  expect(sent).toContain('epic_rebase_push')
  expect(await isAncestor('main', await git('rev-parse', epic.branch))).toBe(true)
  await capture('pause-during-prepare.json', { scenario: 'The project is paused while the runner prepares a clean candidate.', whilePaused: { operation: held[0], jobsSent: [], epicBranchMoved: false }, afterUnpause: { jobsSent: sent, epicBranchMoved: true } })
})

it('starts no fix when paused or stopped during the prepare that found the conflict', async () => {
  const epic = await humanApproved(await conflicted())
  for (const stop of [
    () => t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id)),
    async () => {
      t.orchestrator.gate.stopped = true
    }
  ]) {
    faults = async (job, real) => {
      if (job.kind === 'epic_rebase_prepare') await stop()
      return real()
    }
    await tick()
    expect((await ops(epic.id)).map(o => [o.state, o.fix])).toEqual([['pending', null]])
    expect(await git('branch', '--list', 'corral/epic-rebase/*')).not.toContain((await ops(epic.id))[0]!.id)
    faults = null
    await t.db.update(schema.projects).set({ paused: false }).where(eq(schema.projects.id, project.id))
    t.orchestrator.gate.stopped = false
  }
  await tick()
  expect((await ops(epic.id))).toHaveLength(1)
  expect((await ops(epic.id))[0]!.fix).toBe('conflict')
})

it('holds a human-approved task PR while a rebase has the lock, then merges it', async () => {
  t.github.mergeResult = { merged: true, sha: 'merge-sha', message: 'merged' }
  const epic = await humanApproved(await conflicted())
  await tick()
  const branch = `task-pr-${++branches}`
  await git('branch', branch, epic.branch)
  const head = await commitOn(branch, `${branch}.txt`, 'x\n')
  const pr = await t.github.openPullRequest(TEST_REPOSITORY, { head: branch, base: epic.branch, title: 'Task PR', body: '' })
  const task = await t.createTask(project.slug, { epicId: epic.id, humanReview: true })
  await t.db.delete(schema.acceptanceCriteria).where(eq(schema.acceptanceCriteria.taskId, task.id))
  await t.db.update(schema.tasks).set({ status: 'human_review', branch, headSha: head, prNumber: pr.number, prUrl: pr.url }).where(eq(schema.tasks.id, task.id))
  const [agent] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'reviewer')).limit(1)
  const [run] = await t.db.insert(schema.runs).values({ projectId: project.id, taskId: task.id, agentId: agent!.id, role: 'reviewer', state: 'completed', outcome: 'approved', endedAt: new Date() }).returning()
  await t.db.insert(schema.reviews).values({ taskId: task.id, runId: run!.id, round: 0, headSha: head, verdict: 'approved', summary: 'Good', criteria: [], author: t.actor })
  const merges = () => t.github.calls.filter(c => c.method === 'merge' && c.args[1] === pr.number)

  await t.orchestrator.merges.humanApprove(task.id, t.actor)
  expect(await taskRow(task.id)).toMatchObject({ status: 'ready_to_merge' })
  // The merge attempt approval starts in the background is done
  await expect.poll(() => t.orchestrator.merges.inFlight).toBe(0)
  await tick()
  expect(merges()).toEqual([])
  expect(await taskRow(task.id)).toMatchObject({ status: 'ready_to_merge' })
  await capture('task-pr-held.json', { scenario: 'A human approves a task PR into the task\'s branch while a conflict fix holds the lock.', githubMergeCalls: merges().length, taskStatus: 'ready_to_merge', operations: await journal(epic.id) })

  // GitHub refuses it: recording a merge isn't what this is about, and it reads
  // outside its transaction, which PGlite's one connection can't do
  t.github.mergeResult = { merged: false, sha: null, message: 'Not now' }
  await t.db.update(schema.taskIntegrationOperations).set({ state: 'failed', error: 'Done with' }).where(eq(schema.taskIntegrationOperations.epicId, epic.id))
  await tick()
  expect(merges()).toHaveLength(1)
})

it('bounds infrastructure failures, then shows a recoverable failure and asks the human for no approval', async () => {
  const epic = await createEpic()
  await commitOn('main', `x-${++branches}.txt`, 'x\n')
  await approved(epic, 'a.txt')
  faults = async (job, real) => {
    if (job.kind === 'epic_rebase_prepare') throw new Error('network down')
    return real()
  }
  for (let n = 0; n < 8; n++) {
    await tick()
    t.clock.now = new Date(t.clock.now.getTime() + 5 * 60_000)
  }
  const failed = (await ops(epic.id)).filter(o => o.kind === 'rebase')
  expect(failed).toHaveLength(3)
  expect((await epicApi(epic.id)).sync).toMatchObject({ state: 'failed', error: expect.stringContaining('network down') })
  // Exhausted recovery is the human's to see (D11)
  expect(await needsYou(epic.id)).toMatchObject([{ type: 'epic_conflict', stopped: { error: expect.stringContaining('network down'), fix: null } }])
  const stopped = { epicSync: (await epicApi(epic.id)).sync, inboxNeedsYou: await needsYou(epic.id), operationsAfterEightPasses: await journal(epic.id) }

  faults = null
  const retried = await t.request('POST', `/api/epics/${epic.id}/sync/retry`)
  expect(retried.status).toBe(200)
  await capture('exhausted-retries.json', { stopped, retryResponse: { status: retried.status, body: await retried.json() } })
  await tick()
  expect(await isAncestor('main', await git('rev-parse', epic.branch))).toBe(true)
  expect((await epicApi(epic.id)).sync).toBeNull()
  expect((await t.request('POST', `/api/epics/${epic.id}/sync/retry`)).status).toBe(409)
})

// ── Approval across rebases (COR-291) ───────────────────────────────────────

const inbox = async () => (await t.request('GET', '/api/inbox')).json() as Promise<{ needsYou: { id: string, type: string, decision?: { question: string, alternatives: { label: string }[], affectedChanges: string[] } }[] }>
const history = async (id: string) => (await t.request('GET', `/api/epics/${id}/history`)).json() as Promise<{ event: string, text: string, detail: Record<string, unknown> }[]>
const approvalEvents = async (id: string) => (await history(id)).filter(e => e.event.startsWith('approval_'))

const decision = {
  question: 'Should exports keep filtering?',
  bindingDecision: 'D31 changed on the target',
  alternatives: [
    { label: 'Keep filtering', effect: 'Stays as approved', changesBehaviour: false },
    { label: 'Follow the target', effect: 'Exports every row', changesBehaviour: true }
  ],
  affectedChanges: ['target: export everything', 'task: filtered exports']
}

// An open epic PR at its head, approved by the human
async function humanApproved<E extends { id: string, branch: string, head: string }>(epic: E) {
  const pr = await t.github.openPullRequest(TEST_REPOSITORY, { head: epic.branch, base: 'main', title: 'Feature', body: '' })
  await t.db.update(schema.epics).set({ prNumber: pr.number, prHeadSha: epic.head, reviewState: 'ready_to_merge', approvedHeadSha: epic.head, approvedBaseSha: 'old-base' }).where(eq(schema.epics.id, epic.id))
  return epic
}

it('keeps the human approval over a clean rebase and waits for checks on the new head', async () => {
  await t.db.update(schema.projects).set({ requiredChecks: ['ci'] }).where(eq(schema.projects.id, project.id))
  try {
    const epic = await humanApproved(await createEpic())
    const task = await t.createTask(project.slug, { epicId: epic.id })
    await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, task.id))
    t.github.setChecks(epic.head, [{ name: 'ci', conclusion: 'success', url: null }])
    const onto = await commitOn('main', `moved-${++branches}.txt`, 'x\n')

    await tick()
    const head = await git('rev-parse', epic.branch)
    expect(head).not.toBe(epic.head)
    expect(await reload(epic.id)).toMatchObject({ reviewState: 'ready_to_merge', prHeadSha: head, approvedHeadSha: epic.head, approvedBaseSha: onto })
    await t.mergePass()
    await t.orchestrator.scheduler.schedule()
    expect((await reload(epic.id)).reviewState).toBe('ready_to_merge') // No checks on the new head yet, and no new review
    expect(t.github.calls.filter(c => c.method === 'merge' && c.args[3] === head)).toEqual([])
    t.github.setChecks(head, [{ name: 'ci', conclusion: 'success', url: null }])
    await t.mergePass()
    expect(t.github.calls.filter(c => c.method === 'merge' && c.args[3] === head)).not.toEqual([])
    const [retained] = await approvalEvents(epic.id)
    expect(retained).toMatchObject({ event: 'approval_retained', detail: { approvedHeadSha: epic.head, from: epic.head, to: head, ontoSha: onto } })
    await capture('clean-rebase.json', { scenario: 'A human-approved task is rebased cleanly, then waits for ci on the new head.', approvedCommit: epic.head, rebasedCommit: head, stateBeforeChecks: 'ready_to_merge, no merge call', stateAfterChecks: 'merge requested for the new head', history: await history(epic.id) })
  } finally {
    await t.db.update(schema.projects).set({ requiredChecks: [] }).where(eq(schema.projects.id, project.id))
  }
})

it('never lets an external head inherit approval', async () => {
  // Pushed over an approved head, on top of the target so only the head differs
  const epic = await humanApproved(await createEpic())
  const task = await t.createTask(project.slug, { epicId: epic.id })
  await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, task.id))
  const outside = await commitOn(epic.branch, `outside-${++branches}.txt`, 'x\n')
  await t.mergePass()
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'in_review', prHeadSha: outside, approvedHeadSha: null })
  expect((await approvalEvents(epic.id))[0]).toMatchObject({ event: 'approval_invalidated', detail: { approvedHeadSha: epic.head, from: epic.head, to: outside, operationId: null } })
  await capture('external-head.json', { scenario: 'A commit pushed straight to the approved task\'s branch.', approvedCommit: epic.head, externalCommit: outside, epic: { reviewState: 'in_review', approvedHeadSha: null }, history: await approvalEvents(epic.id) })

  // Rebased from the external head before anything noticed it
  const second = await humanApproved(await createEpic())
  const secondTask = await t.createTask(project.slug, { epicId: second.id })
  await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, secondTask.id))
  await commitOn(second.branch, `outside-${++branches}.txt`, 'x\n')
  await commitOn('main', `moved-${++branches}.txt`, 'x\n')
  await tick()
  const rebased = await git('rev-parse', second.branch)
  expect((await ops(second.id))[0]).toMatchObject({ state: 'succeeded', resultHeadSha: rebased })
  expect(await reload(second.id)).toMatchObject({ reviewState: 'open', prHeadSha: second.head, approvedHeadSha: null })
  expect((await approvalEvents(second.id))[0]).toMatchObject({ event: 'approval_invalidated', detail: { to: rebased } })
})

async function closePr(epic: { id: string }, state: 'open' | 'closed') {
  const { prNumber } = await reload(epic.id)
  t.github.pulls.get(prNumber!)!.state = state
}

async function finished<E extends { id: string }>(epic: E) {
  const task = await t.createTask(project.slug, { epicId: epic.id })
  await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, task.id))
  return epic
}

it('leaves the branch of a closed task\'s PR alone, and rebases once it is reopened', async () => {
  const epic = await finished(await humanApproved(await createEpic()))
  await closePr(epic, 'closed')
  await t.mergePass()
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'open', approvedHeadSha: null })

  const onto = await commitOn('main', `moved-${++branches}.txt`, 'x\n')
  for (let n = 0; n < 3; n++) {
    await t.mergePass()
    await t.orchestrator.scheduler.schedule()
  }
  expect(await git('rev-parse', epic.branch)).toBe(epic.head)
  expect(await ops(epic.id)).toEqual([])
  expect((await reload(epic.id)).reviewState).toBe('open')
  await capture('closed-pr.json', { scenario: 'A human closes the task\'s PR without merging, then the target moves. Three merge passes later:', pr: 'closed', epicBranchMoved: false, operations: await journal(epic.id) })

  // Reconcile's closedPoll sees the reopen and the synchronizer brings it up to date
  await closePr(epic, 'open')
  await t.mergePass()
  const head = await git('rev-parse', epic.branch)
  expect(await isAncestor(onto, head)).toBe(true)
  expect((await ops(epic.id)).map(o => [o.kind, o.state])).toEqual([['rebase', 'succeeded']])
  t.clock.now = new Date(t.clock.now.getTime() + 121_000)
  await t.orchestrator.scheduler.schedule()
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'in_review', prHeadSha: head })
  await capture('closed-pr-reopened.json', { scenario: 'The same PR is reopened.', epicHeadBefore: epic.head, epicHeadAfter: head, operations: await journal(epic.id), reviewState: 'in_review' })
})

it('starts no rebase when the merge pass has not seen the close yet', async () => {
  const epic = await finished(await humanApproved(await createEpic()))
  await closePr(epic, 'closed')
  await commitOn('main', `moved-${++branches}.txt`, 'x\n')
  await tick()
  expect(await git('rev-parse', epic.branch)).toBe(epic.head)
  expect(await ops(epic.id)).toEqual([])
})

it('reads GitHub on a backoff for a task with subtasks idling at a checkpoint, however often the pass runs', async () => {
  const epic = await finished(await createEpic())
  await t.db.update(schema.epics).set({ reviewState: 'human_review', prHeadSha: epic.head }).where(eq(schema.epics.id, epic.id))
  const heads = vi.spyOn(t.github, 'branchHead')
  const behind = vi.spyOn(t.github, 'behindBy')
  onTestFinished(() => {
    heads.mockRestore()
    behind.mockRestore()
  })
  // Ten minutes of 15 second ticks: looks at 0, 30, 90, 210, 330, 450 and 570s
  for (let n = 0; n < 40; n++) {
    await tick()
    t.clock.now = new Date(t.clock.now.getTime() + 15_000)
  }
  expect(heads).toHaveBeenCalledTimes(14)
  expect(behind).toHaveBeenCalledTimes(7)
  await capture('idle-reads.json', { scenario: 'One task parked in Human review, up to date, for 40 ticks 15 seconds apart.', githubReads: heads.mock.calls.length + behind.mock.calls.length, withoutBackoff: 120 })
})

it('does not make a task wait for the backoff: its checkpoint reads at once', async () => {
  const epic = await finished(await createEpic())
  await tick()
  const landed = await commitOn('main', `moved-${++branches}.txt`, 'x\n')
  await tick()
  expect(await ops(epic.id)).toEqual([])

  const task = await approved(epic, 'late.txt')
  await tick()
  expect(await taskRow(task.id)).toMatchObject({ status: 'merged' })
  expect(await isAncestor(landed, await git('rev-parse', epic.branch))).toBe(true)
  expect((await ops(epic.id)).map(o => o.kind)).toEqual(['rebase', 'integrate'])
})

it('looks again soon after a target move once the wait is over', async () => {
  const epic = await finished(await createEpic())
  await tick()
  const landed = await commitOn('main', `moved-${++branches}.txt`, 'x\n')
  t.clock.now = new Date(t.clock.now.getTime() + 31_000)
  await tick()
  expect(await isAncestor(landed, await git('rev-parse', epic.branch))).toBe(true)
})

// ── Developer runs on the epic (D29)

const fixJob = async (epicId: string) => {
  await t.orchestrator.scheduler.schedule()
  return (await runner.next('run.assign', m => m.job.role === 'developer' && m.job.epicId === epicId && m.job.taskId === null)).job
}
const fixReport = (job: { runId: string, leaseEpoch: number }, report: Record<string, unknown>) => runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'pr_updated', summary: 'Kept both sides', note: 'Resolved the conflict', ...report })
const fixEpic = async (id: string) => (await t.request('GET', `/api/epics/${id}`)).json() as Promise<{ sync: Record<string, unknown> | null, reviewState: string, fixes: { runId: string, fix: string, reason: string, behaviourChanged: boolean | null, reReviewed: boolean | null }[], tasks: unknown[] }>

async function conflictFix<E extends { id: string, onto: string, file: string }>(epic: E, text = 'target version\nepic version\n') {
  await tick()
  const [operation] = await ops(epic.id)
  const job = await fixJob(epic.id)
  const resolved = await resolve(job.branch!, epic.onto, epic.file, text)
  return { operation: operation!, job, resolved }
}

describe('developer runs on the epic', () => {
  beforeAll(async () => {
    const jobs = runner.onJob
    runner.close()
    runner = await FakeRunner.connect(t.server!.url)
    runner.onJob = jobs
  })

  describe('at and before the final checkpoint (COR-445)', () => {
    async function underReview(epic: Awaited<ReturnType<typeof conflicted>>, values: Partial<typeof schema.epics.$inferInsert> = {}) {
      await humanApproved(epic)
      await t.db.update(schema.epics).set({ reviewState: 'human_review', approvedHeadSha: null, approvedBaseSha: null, ...values }).where(eq(schema.epics.id, epic.id))
      return epic
    }
    const rebases = async (id: string) => (await ops(id)).filter(o => o.kind === 'rebase')
    const developerRuns = (id: string) => t.db.select().from(schema.runs).where(and(eq(schema.runs.epicId, id), eq(schema.runs.role, 'developer')))

    it('defers an each_task task until it is approved, then resolves it', async () => {
      const epic = await underReview(await conflicted(), { reviewMode: 'each_task' })
      await tick()
      expect((await fixEpic(epic.id)).sync).toEqual({ state: 'conflict_pending', files: [epic.file] })
      expect(await needsYou(epic.id)).toEqual([])
      expect(await developerRuns(epic.id)).toEqual([])

      await t.db.update(schema.epics).set({ reviewState: 'ready_to_merge', approvedHeadSha: epic.head }).where(eq(schema.epics.id, epic.id))
      await t.mergePass()
      expect((await rebases(epic.id)).at(-1)).toMatchObject({ state: 'running', fix: 'conflict' })
      await fixJob(epic.id)
    })

    it('starts no developer on an approved task whose head moved outside Corral', async () => {
      const epic = await humanApproved(await conflicted())
      await t.db.update(schema.epics).set({ prHeadSha: 'a-foreign-head' }).where(eq(schema.epics.id, epic.id))
      await tick()
      expect(await rebases(epic.id)).toMatchObject([{ state: 'failed', fix: null }])
    })

    it('holds review back when the target has moved since the conflict was found', async () => {
      const epic = await underReview(await conflicted())
      await tick()
      expect((await reload(epic.id)).reviewState).toBe('human_review')
      await t.db.update(schema.epics).set({ reviewState: 'open' }).where(eq(schema.epics.id, epic.id))
      await commitOn('main', 'unrelated.txt', 'moved\n')
      await t.orchestrator.epicPrs.reconcile()
      expect((await reload(epic.id)).reviewState).toBe('open')
    })

    it('clears a pending conflict when the branch reaches the target outside Corral', async () => {
      const epic = await underReview(await conflicted())
      await tick()
      expect((await fixEpic(epic.id)).sync).toMatchObject({ state: 'conflict_pending' })

      const handMade = await resolve(epic.branch, epic.onto, epic.file, 'target version\nepic version\n')
      await t.db.update(schema.epics).set({ prHeadSha: handMade }).where(eq(schema.epics.id, epic.id))
      await t.mergePass()
      expect((await fixEpic(epic.id)).sync).toBeNull()
      expect(await rebases(epic.id)).toHaveLength(1)
    })
  })

  it('resolves a conflict on the task with no task, keeping approval when behaviour is unchanged and only the conflicted files differ', async () => {
    const epic = await humanApproved(await conflicted())
    const boardBefore = (await t.db.select().from(schema.tasks).where(eq(schema.tasks.epicId, epic.id))).length
    const { operation, job, resolved } = await conflictFix(epic)

    expect(operation).toMatchObject({ kind: 'rebase', state: 'running', fix: 'conflict', conflictFiles: [epic.file] })
    expect(job).toMatchObject({ checkScope: null }) // No required checks here
    expect(job).toMatchObject({ taskId: null, branch: `corral/epic-rebase/${operation.id}`, epicId: epic.id, baseBranch: 'main' })
    expect(job.prompt).toContain(epic.onto)
    const during = await fixEpic(epic.id)
    expect(during.sync).toMatchObject({ state: 'fixing', fix: 'conflict', files: [epic.file], developer: { runId: job.runId, name: expect.any(String) } })
    await capture('fix-in-progress.json', { sync: during.sync })
    {
      const response = await t.request('POST', '/api/plan/sessions', { projectId: project.id, text: 'Which developer is fixing the task?' })
      expect(response.status).toBe(201)
      const pm = (await runner.next('run.assign', m => m.job.role === 'pm')).job
      const activity = await runner.call(pm.runId, pm.leaseEpoch, 'get_agent_activity', {})
      expect(activity.ok).toBe(true)
      await capture('epic-fix-agent-activity.json', { request: { tool: 'get_agent_activity', input: {} }, response: activity })
      const path = `/api/runs?agentId=${(await t.db.select().from(schema.runs).where(eq(schema.runs.id, job.runId)))[0]!.agentId}`
      const listed = await fetch(`${t.server!.url}${path}`)
      await capture('epic-fix-agent-history.json', { method: 'GET', path, status: listed.status, body: await listed.json() })
    }
    const [row] = await t.db.select().from(schema.runs).where(eq(schema.runs.id, job.runId))
    expect(row).toMatchObject({ role: 'developer', epicId: epic.id, taskId: null, operationId: operation.id, fixKind: 'conflict' })

    expect(await fixReport(job, { behaviourChanged: false, headSha: resolved })).toMatchObject({ ok: false, error: expect.stringContaining('conflictedFiles') })
    expect(await fixReport(job, { headSha: resolved, conflictedFiles: [epic.file] })).toMatchObject({ ok: false, error: expect.stringContaining('behaviourChanged') })
    expect(await fixReport(job, { behaviourChanged: false, headSha: resolved, conflictedFiles: [epic.file] })).toMatchObject({ ok: true })
    expect(await git('rev-parse', epic.branch)).toBe(epic.head)
    await tick()

    expect(await git('rev-parse', epic.branch)).toBe(resolved)
    expect(await reload(epic.id)).toMatchObject({ reviewState: 'ready_to_merge', prHeadSha: resolved, approvedHeadSha: epic.head })
    expect((await t.db.select().from(schema.tasks).where(eq(schema.tasks.epicId, epic.id)))).toHaveLength(boardBefore)
    const { fixes, sync } = await fixEpic(epic.id)
    expect(sync).toBeNull()
    expect(fixes).toMatchObject([{ runId: job.runId, fix: 'conflict', behaviourChanged: false, reReviewed: false }])
    expect((await approvalEvents(epic.id)).at(-1)).toMatchObject({ event: 'approval_retained' })
    await expect(git('rev-parse', '--verify', job.branch!)).rejects.toThrow()
    await capture('fix-conflict-kept.json', { history: (await history(epic.id)).map(e => e.text), fixes })
  })

  // COR-434: an epic's change can force an edit to a file only the target changed
  it('publishes a target-only edit only when the fix sends the task back to review', async () => {
    const base = await humanApproved(await conflicted())
    const epic = { ...base, onto: await commitOn('main', 'target-only.md', 'target\n') }
    const { job } = await conflictFix(epic)
    const adapted = await commitOn(job.branch!, 'target-only.md', 'adapted\n')
    expect(await fixReport(job, { behaviourChanged: false, headSha: adapted, conflictedFiles: [epic.file] })).toMatchObject({ ok: true })
    await tick()
    expect(await git('rev-parse', epic.branch)).toBe(epic.head)
    const retry = await fixJob(epic.id)
    expect(await fixReport(retry, { behaviourChanged: true, headSha: adapted, conflictedFiles: [epic.file] })).toMatchObject({ ok: true })
    await tick()
    expect(await git('rev-parse', epic.branch)).toBe(adapted)
    expect(await reload(epic.id)).toMatchObject({ reviewState: 'open', approvedHeadSha: null })
    await t.db.update(schema.epics).set({ reviewState: 'in_review', prHeadSha: adapted }).where(eq(schema.epics.id, epic.id))
    await t.orchestrator.scheduler.schedule()
    const review = (await runner.next('run.assign', m => m.job.role === 'reviewer' && m.job.epicId === epic.id)).job
    expect(review.prompt).toContain('`target-only.md`')
    expect(review.prompt).toContain('+adapted')
  })

  it('waits for a later pass when GitHub fails before a fix can start, spending no attempt', async () => {
    const epic = await humanApproved(await conflicted())
    // Before the pass: its scheduler poke can claim the fix straight away
    const { createBranch } = t.github
    t.github.createBranch = async () => {
      throw new GitHubError(502, 'Bad gateway')
    }
    onTestFinished(() => {
      t.github.createBranch = createBranch
    })
    await tick()
    await t.orchestrator.scheduler.schedule()
    await t.orchestrator.scheduler.schedule()
    const started = await t.db.select().from(schema.runs).where(eq(schema.runs.epicId, epic.id))
    expect(started).toMatchObject([{ state: 'interrupted' }])
    expect((await ops(epic.id))[0]).toMatchObject({ fixAttempts: 0 })
    expect((await reload(epic.id)).syncError).toBeNull()
    t.github.createBranch = createBranch
    t.clock.now = new Date(t.clock.now.getTime() + 10 * 60_000)
    expect((await fixJob(epic.id)).epicId).toBe(epic.id)
  })

  it('starts no fix while the task\'s PR is closed, and starts once it reopens', async () => {
    const epic = await humanApproved(await conflicted())
    // Paused for the pass: its scheduler poke could claim the fix before the
    // PR closes
    const developers = eq(schema.agents.role, 'developer')
    await t.db.update(schema.agents).set({ paused: true }).where(developers)
    await tick()
    const { prNumber } = await reload(epic.id)
    t.github.pulls.get(prNumber!)!.state = 'closed'
    await t.db.update(schema.agents).set({ paused: false }).where(developers)
    await t.orchestrator.scheduler.schedule()
    expect(await t.db.select().from(schema.runs).where(eq(schema.runs.epicId, epic.id))).toEqual([])
    t.github.pulls.get(prNumber!)!.state = 'open'
    expect((await fixJob(epic.id)).epicId).toBe(epic.id)
  })

  it('returns the task to integration review when the developer reports a behaviour change', async () => {
    const epic = await humanApproved(await conflicted())
    const { job, resolved } = await conflictFix(epic)
    expect(await fixReport(job, { behaviourChanged: true, headSha: resolved, conflictedFiles: [epic.file] })).toMatchObject({ ok: true })
    await tick()
    expect(await git('rev-parse', epic.branch)).toBe(resolved)
    expect(await reload(epic.id)).toMatchObject({ reviewState: 'open', approvedHeadSha: null })
    expect((await approvalEvents(epic.id)).at(-1)).toMatchObject({ event: 'approval_invalidated', detail: { reason: expect.stringContaining('behaviour change') } })
    expect((await fixEpic(epic.id)).fixes).toMatchObject([{ behaviourChanged: true, reReviewed: true }])
  })

  it('returns the task to integration review when differences go beyond the conflicted files, or the compare fails', async () => {
    const epic = await humanApproved(await conflicted())
    const { job, resolved } = await conflictFix(epic)
    const extra = await commitOn(job.branch!, 'unrelated.txt', 'slipped in\n')
    t.github.setBranch(TEST_REPOSITORY, job.branch!, extra)
    expect(resolved).not.toBe(extra)
    // The server knows what conflicted: the developer's list can't widen it
    expect(await fixReport(job, { behaviourChanged: false, headSha: extra, conflictedFiles: [epic.file, 'unrelated.txt'] })).toMatchObject({ ok: true })
    await tick()
    expect(await reload(epic.id)).toMatchObject({ reviewState: 'open', approvedHeadSha: null })
    expect((await approvalEvents(epic.id)).at(-1)).toMatchObject({ detail: { reason: expect.stringContaining('unrelated.txt') } })

    const second = await humanApproved(await conflicted())
    const fix = await conflictFix(second)
    const { compare } = t.github
    t.github.compare = async () => {
      throw new Error('GitHub is down')
    }
    onTestFinished(() => {
      t.github.compare = compare
    })
    expect(await fixReport(fix.job, { behaviourChanged: false, headSha: fix.resolved, conflictedFiles: [second.file] })).toMatchObject({ ok: true })
    await tick()
    expect(await reload(second.id)).toMatchObject({ reviewState: 'open', approvedHeadSha: null })
    expect((await approvalEvents(second.id)).at(-1)).toMatchObject({ detail: { reason: expect.stringContaining('could not compare') } })
  })

  it('starts one developer run however often it is polled or the runner reconnects', async () => {
    const epic = await humanApproved(await conflicted())
    for (let n = 0; n < 3; n++) await tick()
    const job = await fixJob(epic.id)
    for (let n = 0; n < 3; n++) {
      await tick()
      await t.orchestrator.scheduler.schedule()
    }
    await t.orchestrator.onConnected([{ runId: job.runId, leaseEpoch: job.leaseEpoch }], 'r1')
    await t.orchestrator.scheduler.schedule()
    const live = await t.db.select().from(schema.runs).where(eq(schema.runs.epicId, epic.id))
    expect(live).toHaveLength(1)
    expect((await ops(epic.id)).filter(o => o.fix)).toHaveLength(1)
  })

  it('holds a human-stopped task fix until Retry and preserves saving work through heartbeats and reconnects', async () => {
    const epic = await humanApproved(await conflicted())
    await tick()
    const job = await fixJob(epic.id)
    await t.orchestrator.onRunMessage({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'epic-saving' }, 'r1')
    expect((await t.request('POST', `/api/runs/${job.runId}/stop`)).status).toBe(200)
    expect(await runner.next('run.stop', m => m.runId === job.runId)).toMatchObject({ keepWork: true })
    for (let n = 0; n < 5; n++) {
      await tick()
      await t.orchestrator.scheduler.schedule()
      expect((await t.request('POST', `/api/runs/${job.runId}/stop`)).status).toBe(409)
    }
    expect((await fixEpic(epic.id)).sync).toMatchObject({ state: 'failed', error: expect.stringContaining('stopped by a human') })
    expect((await ops(epic.id))[0]!.fixAttempts).toBe(0)
    expect(await t.db.select().from(schema.runs).where(eq(schema.runs.epicId, epic.id))).toHaveLength(1)
    const active = [{ runId: job.runId, leaseEpoch: job.leaseEpoch }]
    await t.orchestrator.onHeartbeat(active, 'r1')
    await t.orchestrator.onConnected(active, 'r1')
    // A round-trip tool response follows any earlier stop on this socket.
    await runner.call(job.runId, job.leaseEpoch, 'get_task', {})
    expect(runner.received.filter(m => m.type === 'run.stop' && m.runId === job.runId)).toEqual([])
    await captureEpic('human-stop-held.json', epic.id, { operation: (await ops(epic.id))[0] })
    expect((await t.request('POST', `/api/epics/${epic.id}/sync/retry`)).status).toBe(200)
    expect((await fixJob(epic.id)).runId).not.toBe(job.runId)
    await t.orchestrator.onHeartbeat(active, 'r1')
    expect((await runner.next('run.stop', m => m.runId === job.runId)).keepWork).toBeUndefined()
  })

  it('preserves saving work during the kill switch without spending an attempt', async () => {
    const epic = await humanApproved(await conflicted())
    await tick()
    const job = await fixJob(epic.id)
    await t.orchestrator.onRunMessage({ type: 'run.started', runId: job.runId, leaseEpoch: job.leaseEpoch, agentSessionId: 'epic-kill-saving' }, 'r1')
    await t.orchestrator.controls.stopAll(t.actor)
    expect(await runner.next('run.stop', m => m.runId === job.runId)).toMatchObject({ keepWork: true })
    const active = [{ runId: job.runId, leaseEpoch: job.leaseEpoch }]
    await t.orchestrator.onHeartbeat(active, 'r1')
    await t.orchestrator.onConnected(active, 'r1')
    await runner.call(job.runId, job.leaseEpoch, 'get_task', {})
    expect(runner.received.filter(m => m.type === 'run.stop' && m.runId === job.runId)).toEqual([])
    expect((await ops(epic.id))[0]!.fixAttempts).toBe(0)
    await t.orchestrator.controls.resumeAll(t.actor)
    expect((await fixJob(epic.id)).runId).not.toBe(job.runId)
  })

  it.each(['lease expiry', 'runner shutdown', 'reconciled failure'] as const)('bounds task fixes lost to %s, counting each run once', async (cause) => {
    const epic = await humanApproved(await conflicted())
    await tick()
    for (let n = 0; n < 3; n++) {
      const job = await fixJob(epic.id)
      if (cause === 'lease expiry') {
        t.clock.now = new Date(t.clock.now.getTime() + 16 * 60_000)
        await t.orchestrator.leases.sweepLeases()
        await t.orchestrator.leases.sweepLeases()
      } else if (cause === 'runner shutdown') {
        await t.orchestrator.onRunMessage({ type: 'run.ended', runId: job.runId, leaseEpoch: job.leaseEpoch, headSha: null, exit: { kind: 'runner_shutdown' } }, 'r1')
      } else {
        await t.orchestrator.onConnected([], 'r1')
        const ended = { type: 'run.ended' as const, runId: job.runId, leaseEpoch: job.leaseEpoch, headSha: null, exit: { kind: 'exited' as const, code: 1 } }
        await t.orchestrator.onRunMessage(ended, 'r1')
        await t.orchestrator.onRunMessage(ended, 'r1')
      }
      expect((await ops(epic.id))[0]!.fixAttempts).toBe(n + 1)
    }
    await t.orchestrator.scheduler.schedule()
    expect((await fixEpic(epic.id)).sync).toMatchObject({ state: 'failed', error: expect.stringContaining('3 times') })
    expect(await t.db.select().from(schema.runs).where(eq(schema.runs.epicId, epic.id))).toHaveLength(3)
    await captureEpic(`bounded-${cause.replaceAll(' ', '-')}.json`, epic.id, { operation: (await ops(epic.id))[0] })
    expect((await t.request('POST', `/api/epics/${epic.id}/sync/retry`)).status).toBe(200)
    expect((await fixJob(epic.id)).taskId).toBeNull()
  })

  it('sends a refused candidate back to a developer, then stops with Retry, leaving the task\'s branch alone', async () => {
    const epic = await humanApproved(await conflicted())
    const seen: string[] = []
    const publishResults: unknown[] = []
    faults = async (job, real) => {
      const result = await real()
      if (job.kind === 'epic_rebase_push') publishResults.push({ request: job, response: result })
      return result
    }
    await tick()
    let job = await fixJob(epic.id)
    const resolved = await resolve(job.branch!, epic.onto, epic.file, 'target version\nepic version\n')
    // A real merge commit passes branch existence checks but the runner refuses it.
    const side = `side-${++branches}`
    await git('branch', side, epic.onto)
    await commitOn(side, `${side}.txt`, 'side work\n')
    await git('checkout', '--quiet', job.branch!)
    await git('merge', '--quiet', '--no-ff', side, '-m', 'Invalid merge candidate')
    const refused = await git('rev-parse', 'HEAD')
    await git('checkout', '--quiet', 'main')
    for (let n = 0; n < 3; n++) {
      seen.push(job.runId)
      expect(await fixReport(job, { behaviourChanged: false, headSha: refused, conflictedFiles: [epic.file] })).toMatchObject({ ok: true })
      await tick()
      expect(await git('rev-parse', epic.branch)).toBe(epic.head)
      if (n < 2) {
        job = await fixJob(epic.id)
        // The runner's refusal names the merge commit
        expect(job.prompt).toContain(refused)
      }
    }
    expect((await fixEpic(epic.id)).sync).toMatchObject({ state: 'failed', fix: 'conflict', error: expect.stringContaining('refused') })
    await t.orchestrator.scheduler.schedule()
    expect((await t.db.select().from(schema.runs).where(eq(schema.runs.epicId, epic.id)))).toHaveLength(3)
    const item = (await needsYou(epic.id))
    expect(item).toMatchObject([{ id: epic.id, type: 'epic_conflict', stopped: { fix: 'conflict', error: expect.stringContaining('refused') } }])
    await capture('stopped-needs-you.json', { request: { method: 'GET', url: '/api/inbox' }, needsYouItem: item[0] })
    await captureEpic('publish-refused-stopped.json', epic.id, { publishResults, expectedEpicHead: epic.head, actualEpicHead: await git('rev-parse', epic.branch) })

    faults = null
    expect((await t.request('POST', `/api/epics/${epic.id}/sync/retry`)).status).toBe(200)
    const again = await fixJob(epic.id)
    expect(seen).not.toContain(again.runId)
    await git('branch', '-f', again.branch!, resolved)
    expect(await needsYou(epic.id)).toEqual([])
    expect(await fixReport(again, { behaviourChanged: false, headSha: resolved, conflictedFiles: [epic.file] })).toMatchObject({ ok: true })
    await tick()
    expect(await git('rev-parse', epic.branch)).toBe(resolved)
    await captureEpic('publish-retry-completed.json', epic.id, { resolved, actualEpicHead: await git('rev-parse', epic.branch) })
  })

  it('stops a task with subtasks after three failed developer runs, with the failure shown and a Retry that starts another', async () => {
    const epic = await humanApproved(await conflicted())
    await tick()
    for (let n = 0; n < 3; n++) {
      const job = await fixJob(epic.id)
      expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'failed', summary: 'Could not do it', note: 'Gave up' })).toMatchObject({ ok: true })
    }
    await t.orchestrator.scheduler.schedule()
    expect((await fixEpic(epic.id)).sync).toMatchObject({ state: 'failed', error: expect.stringContaining('Could not do it') })
    expect((await t.request('POST', `/api/epics/${epic.id}/sync/retry`)).status).toBe(200)
    expect((await fixJob(epic.id)).taskId).toBeNull()
  })

  it('escalates a product decision to the human on the same operation, and approval falls with a behaviour-changing answer', async () => {
    const epic = await humanApproved(await conflicted())
    await tick()
    const job = await fixJob(epic.id)
    expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'stuck', summary: 'The sides disagree', note: 'Needs a decision' })).toMatchObject({ ok: false, error: expect.stringContaining('decision') })
    expect(await runner.call(job.runId, job.leaseEpoch, 'report_outcome', { outcome: 'stuck', summary: 'The sides disagree', note: 'Needs a decision', decision })).toMatchObject({ ok: true })
    await t.orchestrator.scheduler.schedule()
    expect((await fixEpic(epic.id)).sync).toMatchObject({ state: 'deciding', question: decision.question })
    expect((await inbox()).needsYou).toEqual(expect.arrayContaining([expect.objectContaining({ id: epic.id, type: 'epic_conflict', decision: expect.objectContaining({ question: decision.question }) })]))

    const answered = await t.request('POST', `/api/epics/${epic.id}/review`, { action: 'decide', headSha: epic.head, alternative: 1 })
    expect(answered.status).toBe(200)
    const next = await fixJob(epic.id)
    expect(next.prompt).toContain('Follow the target')
    const resolved = await resolve(next.branch!, epic.onto, epic.file, 'target version\n')
    expect(await fixReport(next, { behaviourChanged: false, headSha: resolved, conflictedFiles: [epic.file] })).toMatchObject({ ok: true })
    await tick()
    expect(await reload(epic.id)).toMatchObject({ reviewState: 'open', approvedHeadSha: null })
  })

  describe('a failed required check on an epic PR', () => {
    const failing = async () => {
      await t.db.update(schema.projects).set({ requiredChecks: ['ci'] }).where(eq(schema.projects.id, project.id))
      onTestFinished(async () => {
        await t.db.update(schema.projects).set({ requiredChecks: [] }).where(eq(schema.projects.id, project.id))
        t.github.ciLogs.clear()
      })
      const epic = await humanApproved(await createEpic())
      const done = await t.createTask(project.slug, { epicId: epic.id, humanReview: false })
      await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, done.id))
      t.github.setChecks(epic.head, [{ name: 'ci', conclusion: 'failure', url: 'https://github.com/x/y/actions/runs/1/job/2' }])
      t.github.ciLogs.set('ci', { step: 'Run tests', log: 'noise\nFAIL src/app.test.ts\n##[error]Process completed with exit code 1.\nPost job cleanup.' })
      return epic
    }
    const committed = async (job: { branch: string | null }, name: string) => {
      const head = await commitOn(job.branch!, name, 'fixed\n')
      return head
    }

    it('refuses an unchanged CI fix that edits a file the task never touched, and shows the reviewer one that says it changed behaviour', async () => {
      const shared = `main-only-${++branches}.test.ts`
      await commitOn('main', shared, 'test("main")\n')
      const epic = await failing()
      await t.mergePass()
      const job = await fixJob(epic.id)
      const gutted = await commitOn(job.branch!, shared, 'gutted\n')
      t.github.setBranch(TEST_REPOSITORY, job.branch!, gutted)
      expect(await fixReport(job, { behaviourChanged: false, headSha: gutted })).toMatchObject({ ok: true })
      t.clock.now = new Date(t.clock.now.getTime() + 5 * 60_000)
      await tick()
      expect(await git('rev-parse', epic.branch)).toBe(epic.head)
      expect((await ops(epic.id)).find(o => o.fix === 'ci')).toMatchObject({ fixAttempts: 1, fixReport: null })
      const retry = await fixJob(epic.id)
      expect(retry.prompt).toContain(shared)
      // The second runner's worktree must reach what the first one pushed
      expect(retry.continueFrom).toBe(gutted)
      expect(await fixReport(retry, { behaviourChanged: true, headSha: gutted })).toMatchObject({ ok: true })
      t.clock.now = new Date(t.clock.now.getTime() + 5 * 60_000)
      await tick()
      expect(await git('rev-parse', epic.branch)).toBe(gutted)
      expect((await ops(epic.id)).find(o => o.fix === 'ci')!.fixReport).toMatchObject({ targetFiles: [{ path: shared, diff: expect.stringContaining('+gutted') }] })
    })

    it('creates no task, gives the developer CI\'s output, and keeps approval until CI passes when behaviour is unchanged', async () => {
      const epic = await failing()
      await t.mergePass()
      const job = await fixJob(epic.id)
      expect(job.prompt).toContain('Run tests')
      expect(job.prompt).toContain('FAIL src/app.test.ts')
      expect(job.prompt).not.toContain('Post job cleanup')
      expect(job).toMatchObject({ checkScope: 'targeted' })
      expect(job.continueFrom).toBe(epic.head)
      expect((await t.db.select().from(schema.tasks).where(eq(schema.tasks.epicId, epic.id)))).toHaveLength(1)
      expect((await fixEpic(epic.id)).sync).toMatchObject({ state: 'fixing', fix: 'ci' })
      const head = await committed(job, `fix-${++branches}.txt`)
      expect(await fixReport(job, { behaviourChanged: false, headSha: head })).toMatchObject({ ok: true })
      t.clock.now = new Date(t.clock.now.getTime() + 5 * 60_000)
      await tick()
      expect(await reload(epic.id)).toMatchObject({ reviewState: 'ready_to_merge', prHeadSha: head, approvedHeadSha: epic.head })
      expect(await git('rev-parse', epic.branch)).toBe(head)
      await t.mergePass()
      expect((await reload(epic.id)).reviewState).toBe('ready_to_merge')
      await capture('epic-ci-awaits-new-head.json', { epic: await fixEpic(epic.id), history: await history(epic.id), branchHead: await git('rev-parse', epic.branch) })
      t.github.setChecks(head, [{ name: 'ci', conclusion: 'success', url: null }])
      t.github.pulls.get((await reload(epic.id)).prNumber!)!.mergeable = true
      await t.mergePass()
      expect(t.github.calls.filter(c => c.method === 'merge' && c.args[3] === head)).not.toEqual([])
    })

    it('returns the task to integration review when the fix changes behaviour', async () => {
      const epic = await failing()
      await t.mergePass()
      const job = await fixJob(epic.id)
      const head = await committed(job, `fix-${++branches}.txt`)
      expect(await fixReport(job, { behaviourChanged: true, headSha: head })).toMatchObject({ ok: true })
      t.clock.now = new Date(t.clock.now.getTime() + 5 * 60_000)
      await tick()
      expect(await reload(epic.id)).toMatchObject({ reviewState: 'open', approvedHeadSha: null })
    })

    it('still starts the round when the log can\'t be read, and links the run', async () => {
      const epic = await failing()
      t.github.ciLogs.clear()
      await t.mergePass()
      const job = await fixJob(epic.id)
      expect(job.prompt).toContain('https://github.com/x/y/actions/runs/1/job/2')
    })

    it('stops after three published fixes that CI keeps failing, and Retry starts another run', async () => {
      const epic = await failing()
      for (let n = 0; n < 3; n++) {
        await t.mergePass()
        const job = await fixJob(epic.id)
        const head = await committed(job, `fix-${++branches}.txt`)
        t.github.setChecks(head, [{ name: 'ci', conclusion: 'failure', url: null }])
        expect(await fixReport(job, { behaviourChanged: false, headSha: head })).toMatchObject({ ok: true })
        await tick()
        t.clock.now = new Date(t.clock.now.getTime() + 10 * 60_000)
      }
      await t.mergePass()
      expect((await fixEpic(epic.id)).sync).toMatchObject({ state: 'failed', fix: 'ci', error: expect.stringContaining('still failing') })
      await t.orchestrator.scheduler.schedule()
      expect((await t.db.select().from(schema.runs).where(eq(schema.runs.epicId, epic.id)))).toHaveLength(3)
      expect((await t.request('POST', `/api/epics/${epic.id}/sync/retry`)).status).toBe(200)
      expect((await fixJob(epic.id)).taskId).toBeNull()
      const history = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.action, 'epic.pr'))
      const stops = history.filter(row => (row.detail as { epicId?: string }).epicId === epic.id).map(row => readAudit(row.detail)).filter(detail => detail.event?.startsWith('sync_')).map(detail => detail.event)
      expect(stops).toEqual(['sync_failed', 'sync_retried'])
    })
  })

  it('still creates a task for a human Request changes', async () => {
    const epic = await humanApproved(await finished(await createEpic()))
    await t.db.update(schema.epics).set({ reviewState: 'human_review' }).where(eq(schema.epics.id, epic.id))
    const response = await fetch(`${t.server!.url}/api/epics/${epic.id}/review`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ action: 'request_changes', headSha: epic.head, text: 'Show export progress on small screens.' }) })
    const body = await response.json()
    expect(response.status).toBe(200)
    const tasks = await t.db.select().from(schema.tasks).where(eq(schema.tasks.epicId, epic.id))
    expect(tasks).toHaveLength(2)
    expect(tasks.find(t => t.status === 'ready')).toMatchObject({ title: expect.any(String) })
    await capture('human-request-changes.json', { method: 'POST', path: `/api/epics/${epic.id}/review`, status: response.status, body, epic: await fixEpic(epic.id) })
  })

  it('sends integration review changes to a developer run with no task, and reviews again with the last commit and summary', async () => {
    const epic = await createEpic()
    const done = await t.createTask(project.slug, { epicId: epic.id, humanReview: false })
    await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, done.id))
    await t.orchestrator.scheduler.schedule()
    const first = (await runner.next('run.assign', m => m.job.role === 'reviewer' && m.job.epicId === epic.id)).job
    expect(first.prompt).toMatch(/git diff origin\/\S+\.\.\.HEAD/)
    expect(await runner.call(first.runId, first.leaseEpoch, 'report_outcome', { outcome: 'changes_requested', summary: 'The UI sends the wrong field' })).toMatchObject({ ok: true })
    expect(await reload(epic.id)).toMatchObject({ reviewState: 'changes_requested' })
    const job = await fixJob(epic.id)
    expect(job.prompt).toContain('The UI sends the wrong field')
    expect((await t.db.select().from(schema.tasks).where(eq(schema.tasks.epicId, epic.id)))).toHaveLength(1)
    const head = await commitOn(job.branch!, `fix-${++branches}.txt`, 'fixed\n')
    expect(await fixReport(job, { behaviourChanged: false, headSha: head })).toMatchObject({ ok: true })
    await tick()
    expect(await git('rev-parse', epic.branch)).toBe(head)
    await t.orchestrator.scheduler.schedule()
    const repeat = (await runner.next('run.assign', m => m.job.role === 'reviewer' && m.job.epicId === epic.id && m.job.runId !== first.runId)).job
    expect(repeat.prompt).toContain(epic.head)
    expect(repeat.prompt).toContain('The UI sends the wrong field')
    expect(repeat.prompt).not.toMatch(/git diff origin\/\S+\.\.\.HEAD/)
    await capture('repeat-review-prompt.json', { prompt: repeat.prompt })
  })
})
