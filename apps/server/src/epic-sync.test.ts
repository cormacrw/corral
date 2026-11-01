import { TASK_INTEGRATION_PROTOCOL } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, beforeAll, beforeEach, expect, it, vi } from 'vitest'
import { prepareEpicRebase, pushEpicRebase } from '../../runner/src/epic-rebase.ts'
import { exec } from '../../runner/src/exec.ts'
import { inspectIntegration, prepareIntegration, pushIntegration } from '../../runner/src/integration.ts'
import { createTestDataDir, TEST_REPOSITORY } from '../../runner/src/test-repo.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'
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
  t.github.createBranch = async (_, branch, sha) => void await git('branch', branch, sha)
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
  runner = await FakeRunner.connect(t.server!.url, [], 'r1', { taskIntegrationProtocols: [TASK_INTEGRATION_PROTOCOL], taskIntegrationExecutor: true, epicRebaseExecutor: true })
  const fallback = runner.onJob
  runner.onJob = async (job) => {
    const real = async () => {
      switch (job.kind) {
        case 'integration_prepare': return prepareIntegration(dataDir, null, job)
        case 'integration_push': return pushIntegration(dataDir, job)
        case 'integration_inspect': return inspectIntegration(dataDir, job)
        case 'epic_rebase_prepare': return prepareEpicRebase(dataDir, null, job)
        case 'epic_rebase_push': return pushEpicRebase(dataDir, job)
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
  // An agent running these tests has a push URL that always fails
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  faults = null
  t.orchestrator.merges.stopped = false
  await t.db.update(schema.projects).set({ paused: false }).where(eq(schema.projects.id, project.id))
  await git('checkout', '--quiet', '--force', 'main')
})

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
  const head = await commitOn(branch, `${branch}.txt`, 'epic work\n')
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

const tick = () => t.orchestrator.merges.tick()
const ops = (epicId: string) => t.db.select().from(schema.taskIntegrationOperations).where(eq(schema.taskIntegrationOperations.epicId, epicId)).orderBy(schema.taskIntegrationOperations.leaseEpoch)
const reload = async (id: string) => (await t.db.select().from(schema.epics).where(eq(schema.epics.id, id)))[0]!
const epicApi = async (id: string) => (await t.request('GET', `/api/epics/${id}`)).json() as Promise<{ sync: unknown, reviewState: string | null }>
const taskRow = async (id: string) => (await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, id)))[0]!
const isAncestor = (a: string, b: string) => git('merge-base', '--is-ancestor', a, b).then(() => true, () => false)
const needsYou = async (id: string) => ((await (await t.request('GET', '/api/inbox')).json()) as { needsYou: { id: string, epicId?: string }[] }).needsYou.filter(i => i.epicId === id || i.id === id)

// Target and epic both change `file`, so the rebase can only conflict
async function conflicted() {
  const epic = await createEpic()
  await commitOn(epic.branch, epic.file, 'epic version\n')
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

async function developerSubmits(taskId: string, head: string) {
  await t.orchestrator.schedule()
  const dev = (await runner.next('run.assign', m => m.job.role === 'developer' && m.job.taskId === taskId)).job
  const criteria = await t.db.select().from(schema.acceptanceCriteria).where(eq(schema.acceptanceCriteria.taskId, taskId))
  for (const c of criteria) await runner.call(dev.runId, dev.leaseEpoch, 'attach_evidence', { criterionId: c.id, kind: 'note', note: 'Kept both sides' })
  expect(await runner.call(dev.runId, dev.leaseEpoch, 'report_outcome', { outcome: 'pr_updated', note: 'Resolved', summary: 'Rebased', headSha: head })).toMatchObject({ ok: true })
  return { dev, criteria }
}

async function reviewerApproves(taskId: string, head: string, criteria: { id: string }[]) {
  await t.orchestrator.schedule()
  const review = (await runner.next('run.assign', m => m.job.role === 'reviewer' && m.job.taskId === taskId)).job
  expect(review.headSha).toBe(head)
  expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Both sides kept', criteria: criteria.map(c => ({ criterionId: c.id, met: true, note: '' })) })).toMatchObject({ ok: true })
}

it('rebases an active epic at the next task integration, with no hand-off and no task PR', async () => {
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
})

it('rebases before review, and keeps approval over a clean rebase before merge', async () => {
  const epic = await createEpic({ prNumber: null })
  const task = await t.createTask(project.slug, { epicId: epic.id })
  await t.db.update(schema.tasks).set({ status: 'merged' }).where(eq(schema.tasks.id, task.id))
  await commitOn('main', 'before-review.txt', 'x\n')

  await t.orchestrator.schedule() // held: behind its target
  expect((await reload(epic.id)).reviewState).toBeNull()
  await tick()
  await t.orchestrator.schedule()
  const review = (await runner.next('run.assign', m => m.job.epicId === epic.id)).job
  expect(review.headSha).toBe(await git('rev-parse', epic.branch))
  expect(await isAncestor('main', review.headSha!)).toBe(true)
  expect(await runner.call(review.runId, review.leaseEpoch, 'report_outcome', { outcome: 'approved', summary: 'Fits' })).toMatchObject({ ok: true })

  // Target moves while the human reads: the head follows and approval stands
  await commitOn('main', 'before-merge.txt', 'x\n')
  await tick()
  const head = await git('rev-parse', epic.branch)
  expect(head).not.toBe(review.headSha)
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'human_review', prHeadSha: head })
  await t.orchestrator.schedule()
  expect(await reload(epic.id)).toMatchObject({ reviewState: 'human_review', prHeadSha: head })
  expect(await needsYou(epic.id)).toHaveLength(1)
  expect(await t.db.select().from(schema.runs).where(eq(schema.runs.epicId, epic.id))).toHaveLength(1)

  expect((await t.request('POST', `/api/epics/${epic.id}/review`, { action: 'approve', headSha: head })).status).toBe(200)
  await commitOn('main', 'just-before-merge.txt', 'x\n')
  await tick()
  await tick()
  const final = await reload(epic.id)
  expect(final.reviewState).toBe('merged')
  expect(t.github.calls.filter(c => c.method === 'updateBranch')).toEqual([])
})

it('sends a conflict to a developer and a reviewer on a candidate, then publishes it with the epic showing progress', async () => {
  const epic = await conflicted()
  await approved(epic, 'waiting.txt')
  await tick()

  const [operation] = await ops(epic.id)
  expect(operation).toMatchObject({ kind: 'rebase', state: 'running', conflictFiles: [epic.file] })
  const fix = await taskRow(operation!.resolutionTaskId!)
  expect(fix).toMatchObject({ integrationProtocol: 0, branch: `corral/epic-rebase/${operation!.id}` })
  expect(await git('rev-parse', fix.branch!)).toBe(epic.head)
  expect(await git('rev-parse', epic.branch)).toBe(epic.head)
  expect((await epicApi(epic.id)).sync).toMatchObject({ state: 'resolving', files: [epic.file], taskId: fix.id })
  expect(await needsYou(epic.id)).toEqual([])

  const prs = t.github.pulls.size
  const resolved = await resolve(fix.branch!, epic.onto, epic.file, 'target version\nepic version\n')
  const { dev, criteria } = await developerSubmits(fix.id, resolved)
  expect(dev.baseBranch).toBe('main')
  expect(dev.prompt).toContain(`git rebase ${epic.onto}`)
  expect(dev.prompt).toContain('never remove or revert')
  expect(t.github.pulls.size).toBe(prs)
  expect(await git('rev-parse', epic.branch)).toBe(epic.head)

  await reviewerApproves(fix.id, resolved, criteria)
  await tick()
  expect(await git('rev-parse', epic.branch).then(async h => isAncestor(resolved, h))).toBe(true)
  expect(await taskRow(fix.id)).toMatchObject({ status: 'merged', mergeCommitSha: resolved })
  expect(await git('show', `${epic.branch}:${epic.file}`)).toBe('target version\nepic version')
  expect((await ops(epic.id)).map(o => [o.kind, o.state])).toEqual([['rebase', 'succeeded'], ['integrate', 'succeeded']])
  await expect(git('rev-parse', '--verify', fix.branch!)).rejects.toThrow()
  expect((await epicApi(epic.id)).sync).toBeNull()
})

it('keeps task integration off the epic branch while a resolution holds the lock', async () => {
  const epic = await conflicted()
  await tick()
  const task = await approved(epic, 'late.txt')
  await tick()
  await tick()
  expect(await taskRow(task.id)).toMatchObject({ status: 'ready_to_merge' })
  expect(await git('rev-parse', epic.branch)).toBe(epic.head)
  expect((await ops(epic.id)).map(o => o.kind)).toEqual(['rebase'])
  // The database refuses a second writer whichever kind it is
  const [submission] = await t.db.select().from(schema.taskSubmissions).where(eq(schema.taskSubmissions.taskId, task.id))
  await expect(t.db.insert(schema.taskIntegrationOperations).values({ submissionId: submission!.id, epicId: epic.id, kind: 'integrate', expectedTargetSha: epic.head, leaseEpoch: 9 })).rejects.toThrow()
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
  expect((await ops(epic.id))[0]).toMatchObject({ kind: 'rebase', state: 'failed', error: 'The epic branch moved' })
  expect(await isAncestor('main', await git('rev-parse', epic.branch))).toBe(true)
})

it('starts one resolution for the same commits, however often it is polled or reported', async () => {
  const epic = await conflicted()
  await Promise.all([tick(), tick(), tick()])
  await tick()
  await t.orchestrator.schedule()
  await tick()
  expect(await ops(epic.id)).toHaveLength(1)
  const board = await t.db.select().from(schema.tasks).where(eq(schema.tasks.epicId, epic.id))
  expect(board.filter(row => row.id !== epic.done.id)).toHaveLength(1)
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
      t.orchestrator.merges.stopped = true
    }
    return real()
  }
  await tick().catch(() => null)
  await t.orchestrator.merges.tick()
  const sent: string[] = []
  faults = async (job, real) => {
    sent.push(job.kind)
    return real()
  }
  // The pass that was running saw `stopped` before it pushed
  expect(await git('rev-parse', epic.branch)).toBe(epic.head)
  expect((await ops(epic.id))[0]).toMatchObject({ state: 'running' })
  t.orchestrator.merges.stopped = false
  await tick()
  expect(sent).toContain('epic_rebase_push')
  expect(await isAncestor('main', await git('rev-parse', epic.branch))).toBe(true)
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
  expect(await needsYou(epic.id)).toEqual([])

  faults = null
  expect((await t.request('POST', `/api/epics/${epic.id}/sync/retry`)).status).toBe(200)
  await tick()
  expect(await isAncestor('main', await git('rev-parse', epic.branch))).toBe(true)
  expect((await epicApi(epic.id)).sync).toBeNull()
  expect((await t.request('POST', `/api/epics/${epic.id}/sync/retry`)).status).toBe(409)
})

it('keeps a reviewed resolution through failed pushes, and pushes it again on retry', async () => {
  const epic = await conflicted()
  await tick()
  const [operation] = await ops(epic.id)
  const fix = await taskRow(operation!.resolutionTaskId!)
  const resolved = await resolve(fix.branch!, epic.onto, epic.file, 'target version\nepic version\n')
  const { criteria } = await developerSubmits(fix.id, resolved)
  await reviewerApproves(fix.id, resolved, criteria)
  faults = async (job, real) => {
    if (job.kind === 'epic_rebase_push') throw new Error('push timed out')
    return real()
  }
  for (let n = 0; n < 6; n++) await tick()
  expect((await ops(epic.id))[0]).toMatchObject({ state: 'running', pushAttempts: 3 })
  expect((await epicApi(epic.id)).sync).toMatchObject({ state: 'failed', error: expect.stringContaining('push timed out') })
  expect(await taskRow(fix.id)).toMatchObject({ status: 'ready_to_merge' })

  faults = null
  expect((await t.request('POST', `/api/epics/${epic.id}/sync/retry`)).status).toBe(200)
  await tick()
  expect(await taskRow(fix.id)).toMatchObject({ status: 'merged' })
  expect(await isAncestor(resolved, await git('rev-parse', epic.branch))).toBe(true)
})

it('sends back a resolution that undoes target work, and leaves the epic branch alone', async () => {
  const epic = await conflicted()
  const onto = await commitOn('main', 'landed.txt', 'landed\n')
  await tick()
  const [operation] = await ops(epic.id)
  const fix = await taskRow(operation!.resolutionTaskId!)
  // Rebased, then quietly deletes what just landed
  await resolve(fix.branch!, onto, epic.file, 'epic version\n')
  await git('checkout', '--quiet', fix.branch!)
  await git('rm', '--quiet', 'landed.txt')
  await git('commit', '--quiet', '-m', 'Remove the file that got in the way')
  const bad = await git('rev-parse', 'HEAD')
  await git('checkout', '--quiet', 'main')
  const { criteria } = await developerSubmits(fix.id, bad)
  await reviewerApproves(fix.id, bad, criteria)
  await tick()

  expect(await git('rev-parse', epic.branch)).toBe(epic.head)
  expect(await taskRow(fix.id)).toMatchObject({ status: 'in_progress' })
  const notes = await t.db.select().from(schema.comments).where(eq(schema.comments.taskId, fix.id))
  expect(notes.map(n => n.body).join('\n')).toContain('landed.txt')
  expect((await ops(epic.id))[0]).toMatchObject({ state: 'running', resultHeadSha: null })
  expect((await epicApi(epic.id)).sync).toMatchObject({ state: 'resolving' })
  await readFile(join(origin, 'landed.txt'))
})
