import { TASK_INTEGRATION_PROTOCOL } from '@corral/contracts'
import { schema } from '@corral/db'
import { eq } from 'drizzle-orm'
import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest'
import { exec } from '../../runner/src/exec.ts'
import { inspectIntegration, prepareIntegration, pushIntegration } from '../../runner/src/integration.ts'
import { createTestDataDir, TEST_REPOSITORY } from '../../runner/src/test-repo.ts'
import { claimNextTask } from './claim.ts'
import { publishEpicDependents } from './dependent-tasks.ts'
import { TaskIntegrator } from './task-integration.ts'
import { createTestApp, type TestApp } from './test-app.ts'
import { FakeRunner } from './test-runner.ts'
import { recordTaskSubmission } from './task-submissions.ts'

// Real git processes, so these need more time than the default on a busy machine
vi.setConfig({ testTimeout: 30_000 })

// The real runner git code against a real origin, with the real server deciding.
// Only the WebSocket's far end is a test: `faults` lets a test intervene around a job.
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
  dataDir = await createTestDataDir()
  origin = join(dirname(dataDir), 'origin')
  project = await t.createProject({ repository: TEST_REPOSITORY })
  t.github.branchHead = async (_, branch) => git('rev-parse', '--verify', '--quiet', `refs/heads/${branch}`).catch(() => null)
  t.github.deleteBranch = async (_, branch) => void await git('branch', '-D', branch)
  runner = await FakeRunner.connect(t.server!.url, [], 'r1', { taskIntegrationProtocols: [TASK_INTEGRATION_PROTOCOL], taskIntegrationExecutor: true })
  const fallback = runner.onJob
  runner.onJob = async (job) => {
    const real = async () => {
      switch (job.kind) {
        case 'integration_prepare': return prepareIntegration(dataDir, null, job)
        case 'integration_push': return pushIntegration(dataDir, job)
        case 'integration_inspect': return inspectIntegration(dataDir, job)
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
  await t.db.update(schema.projects).set({ requiredChecks: [] }).where(eq(schema.projects.id, project.id))
})

async function createEpic() {
  const branch = `epic-${++branches}`
  await git('branch', branch, 'main')
  const [epic] = await t.db.insert(schema.epics).values({ projectId: project.id, createdBy: t.actor, title: 'Feature', reviewMode: 'epic', branch }).returning()
  return { ...epic!, branch, base: await git('rev-parse', branch) }
}

// A task in Ready to merge: reviewed and approved on its own branch, cut from `base`
async function approved(epic: Awaited<ReturnType<typeof createEpic>>, file: string, text = `${file}\n`, input = {}) {
  const branch = `task-${++branches}`
  await git('checkout', '--quiet', '-b', branch, epic.base)
  await writeFile(join(origin, file), text)
  await git('add', '.')
  await git('commit', '--quiet', '-m', `Add ${file}`)
  const head = await git('rev-parse', 'HEAD')
  await git('checkout', '--quiet', 'main')
  const task = await t.createTask(project.slug, { epicId: epic.id, humanReview: false, ...input })
  await t.db.update(schema.tasks).set({ branch, integrationProtocol: 1 }).where(eq(schema.tasks.id, task.id))
  const submission = await recordTaskSubmission(t.db, { taskId: task.id, submittedHeadSha: head, baseSha: epic.base })
  await t.db.update(schema.taskSubmissions).set({ agentApprovedHeadSha: head }).where(eq(schema.taskSubmissions.id, submission.id))
  await t.db.update(schema.tasks).set({ status: 'ready_to_merge', headSha: head }).where(eq(schema.tasks.id, task.id))
  return { ...task, head, branch, submissionId: submission.id }
}

const row = async (task: { id: string }) => (await t.db.select().from(schema.tasks).where(eq(schema.tasks.id, task.id)))[0]!
const submission = async (task: { submissionId: string }) => (await t.db.select().from(schema.taskSubmissions).where(eq(schema.taskSubmissions.id, task.submissionId)))[0]!
const ops = (epicId: string) => t.db.select().from(schema.taskIntegrationOperations).where(eq(schema.taskIntegrationOperations.epicId, epicId)).orderBy(schema.taskIntegrationOperations.leaseEpoch)
const trailers = async (branch: string, id: string) => (await git('log', '--format=%H', '--fixed-strings', `--grep=Corral-Submission: ${id}`, branch)).split('\n').filter(Boolean)
const tick = () => t.orchestrator.merges.tick()

it('puts two concurrently approved tasks on the epic branch once each, neither overwriting the other', async () => {
  const epic = await createEpic()
  const [a, b] = [await approved(epic, 'a.txt'), await approved(epic, 'b.txt')]
  await Promise.all([tick(), tick()])
  await tick()

  expect(await row(a)).toMatchObject({ status: 'merged' })
  expect(await row(b)).toMatchObject({ status: 'merged' })
  expect(await git('rev-list', '--count', `${epic.base}..${epic.branch}`)).toBe('2')
  expect((await git('ls-tree', '--name-only', epic.branch)).split('\n')).toEqual(expect.arrayContaining(['a.txt', 'b.txt']))
  for (const task of [a, b]) {
    const [commit] = await trailers(epic.branch, task.submissionId)
    expect(await trailers(epic.branch, task.submissionId)).toHaveLength(1)
    expect(await submission(task)).toMatchObject({ integratedCommitSha: commit, agentApprovedHeadSha: task.head })
    expect((await row(task)).mergeCommitSha).toBe(commit)
    expect(commit).not.toBe(task.head)
  }
  expect((await ops(epic.id)).map(o => o.state)).toEqual(['succeeded', 'succeeded'])
  // The second was expected to land on the first
  const [first, second] = await ops(epic.id)
  expect(second!.expectedTargetSha).toBe(first!.resultHeadSha)
})

it('allows only one active operation per epic', async () => {
  const epic = await createEpic()
  const [a, b] = [await approved(epic, 'a.txt'), await approved(epic, 'b.txt')]
  const values = (id: string) => ({ submissionId: id, epicId: epic.id, kind: 'integrate' as const, expectedTargetSha: epic.base, leaseEpoch: 1 })
  await t.db.insert(schema.taskIntegrationOperations).values(values(a.submissionId))
  await expect(t.db.insert(schema.taskIntegrationOperations).values(values(b.submissionId))).rejects.toThrow()
  await t.db.delete(schema.taskIntegrationOperations).where(eq(schema.taskIntegrationOperations.epicId, epic.id))
  await t.db.update(schema.tasks).set({ status: 'blocked', statusReason: 'Done with' }).where(eq(schema.tasks.epicId, epic.id))
})

it('stays in Ready to merge until a read of the remote shows the integrated commit', async () => {
  const epic = await createEpic()
  const task = await approved(epic, 'a.txt')
  let lies = 1
  faults = async (job, real) => {
    if (job.kind === 'integration_push' && job.targetBranch === epic.branch && lies-- > 0) return { kind: 'integration_push', pushed: true, error: null }
    return real()
  }
  await tick()
  // A runner claiming success changes nothing: the operation failed on the
  // remote's say-so, and only the retry's commit counts
  expect(await ops(epic.id)).toMatchObject([{ state: 'failed', error: 'The push did not reach the epic branch' }])
  expect(await row(task)).toMatchObject({ status: 'ready_to_merge', mergedAt: null })
  await tick()
  const [, second] = await ops(epic.id)
  expect(second).toMatchObject({ state: 'succeeded' })
  expect(await row(task)).toMatchObject({ status: 'merged', mergeCommitSha: second!.resultHeadSha })
  expect(await git('rev-parse', epic.branch)).toBe(second!.resultHeadSha)
})

it('recovers a restart after the push without a second commit', async () => {
  const epic = await createEpic()
  const task = await approved(epic, 'a.txt')
  // The push lands, then the server goes away before it can read or record anything
  faults = async (job, real) => {
    if (job.kind === 'integration_push') {
      await real()
      throw new Error('Runner disconnected')
    }
    if (job.kind === 'integration_inspect') throw new Error('Runner disconnected')
    return real()
  }
  await tick()
  expect(await ops(epic.id)).toMatchObject([{ state: 'reconciling' }])
  expect(await row(task)).toMatchObject({ status: 'ready_to_merge', mergedAt: null })
  expect(await git('rev-list', '--count', `${epic.base}..${epic.branch}`)).toBe('1')

  faults = null
  const settled: string[] = []
  const restarted = new TaskIntegrator({ db: t.db, events: t.bus, github: t.github, runner: t.runner }, async id => void settled.push(id))
  await restarted.tick(() => false)
  const [op] = await ops(epic.id)
  expect(op).toMatchObject({ state: 'succeeded', resultHeadSha: await git('rev-parse', epic.branch) })
  expect(await row(task)).toMatchObject({ status: 'merged', mergeCommitSha: op!.resultHeadSha })
  expect(settled).toContain(task.id)
  expect(await git('rev-list', '--count', `${epic.base}..${epic.branch}`)).toBe('1')
})

it('recovers an operation whose answer was lost before it reached reconciling', async () => {
  const epic = await createEpic()
  const task = await approved(epic, 'a.txt')
  // Crashed part-way: journaled as running, and a stale push landed behind it
  const [op] = await t.db.insert(schema.taskIntegrationOperations).values({ submissionId: task.submissionId, epicId: epic.id, kind: 'integrate', state: 'running', runnerId: 'r1', expectedTargetSha: epic.base, leaseEpoch: 1 }).returning()
  const prepared = await prepareIntegration(dataDir, null, { kind: 'integration_prepare', repository: TEST_REPOSITORY, targetBranch: epic.branch, expectedTargetSha: epic.base, submissionId: task.submissionId, headSha: task.head, baseSha: epic.base, message: `Work\n\nCorral-Submission: ${task.submissionId}\n`, committedAt: new Date().toISOString(), candidateRef: null })
  await pushIntegration(dataDir, { kind: 'integration_push', repository: TEST_REPOSITORY, targetBranch: epic.branch, expectedTargetSha: epic.base, candidateSha: prepared.commitSha! })
  await tick()
  expect((await ops(epic.id))[0]).toMatchObject({ id: op!.id, state: 'succeeded', resultHeadSha: prepared.commitSha })
  expect(await row(task)).toMatchObject({ status: 'merged' })
  expect(await trailers(epic.branch, task.submissionId)).toHaveLength(1)
})

it('refreshes and retries when the epic branch moves between candidate and push', async () => {
  const epic = await createEpic()
  const task = await approved(epic, 'a.txt')
  let newer = ''
  faults = async (job, real) => {
    if (job.kind === 'integration_push' && !newer) {
      await git('checkout', '--quiet', '-b', `newer-${epic.id}`, epic.branch)
      await writeFile(join(origin, 'newer.txt'), 'newer\n')
      await git('add', '.')
      await git('commit', '--quiet', '-m', 'Newer epic work')
      newer = await git('rev-parse', 'HEAD')
      await git('checkout', '--quiet', 'main')
      await git('update-ref', `refs/heads/${epic.branch}`, newer)
    }
    return real()
  }
  await tick()
  const [first, second] = await ops(epic.id)
  expect(first).toMatchObject({ state: 'failed', error: 'The epic branch moved', expectedTargetSha: epic.base })
  expect(second).toMatchObject({ state: 'succeeded', expectedTargetSha: newer })
  expect(second!.leaseEpoch).toBeGreaterThan(first!.leaseEpoch)
  expect(await git('merge-base', '--is-ancestor', newer, epic.branch).then(() => true)).toBe(true)
  expect((await git('ls-tree', '--name-only', epic.branch)).split('\n')).toEqual(expect.arrayContaining(['a.txt', 'newer.txt']))
  expect(await row(task)).toMatchObject({ status: 'merged' })
})

it('sends a conflicted candidate to a rebase round: the branch stays put and dependents stay blocked', async () => {
  const epic = await createEpic()
  const a = await approved(epic, 'same.txt', 'a\n')
  const b = await approved(epic, 'same.txt', 'b\n')
  const dependent = await t.createTask(project.slug, { epicId: epic.id, dependsOn: [b.number] })
  await t.request('POST', `/api/projects/${project.slug}/tasks/${dependent.number}/transitions`, { type: 'approve' })
  await tick()
  await tick()
  const head = await git('rev-parse', epic.branch)
  expect(await row(a)).toMatchObject({ status: 'merged' })
  expect(await row(b)).toMatchObject({ status: 'in_progress', rebaseOnly: true, approvedHeadSha: b.head, mergedAt: null })
  expect(await submission(b)).toMatchObject({ integratedCommitSha: null })
  expect(await git('rev-list', '--count', `${epic.base}..${epic.branch}`)).toBe('1')
  expect(head).toBe((await row(a)).mergeCommitSha)
  const notes = await t.db.select().from(schema.comments).where(eq(schema.comments.taskId, b.id))
  expect(notes.at(-1)!.body).toContain('`same.txt`')
  expect(notes.at(-1)!.body).toContain('report commit_submitted')
  const [developer] = await t.db.select().from(schema.agents).where(eq(schema.agents.role, 'developer'))
  expect(await claimNextTask(t.db, developer!.id, t.clock.now, [dependent.id])).toBeNull()
})

it('checks the exact candidate on CI: a failure sends the task back and the branch never moves', async () => {
  await t.db.update(schema.projects).set({ requiredChecks: ['ci'] }).where(eq(schema.projects.id, project.id))
  const epic = await createEpic()
  const task = await approved(epic, 'a.txt')
  await tick()
  const [op] = await ops(epic.id)
  expect(op).toMatchObject({ state: 'running' })
  const candidate = op!.resultHeadSha!
  expect(await git('rev-parse', `corral/candidates/${op!.id}`)).toBe(candidate)
  expect(await git('rev-parse', epic.branch)).toBe(epic.base)

  t.github.setChecks(candidate, [{ name: 'ci', conclusion: 'pending', url: null }])
  await tick()
  expect(await git('rev-parse', epic.branch)).toBe(epic.base)
  t.github.setChecks(candidate, [{ name: 'ci', conclusion: 'failure', url: 'https://ci/1' }])
  await tick()
  expect(await row(task)).toMatchObject({ status: 'in_progress', rebaseOnly: false, mergedAt: null })
  expect((await ops(epic.id))[0]).toMatchObject({ state: 'failed' })
  expect(await git('rev-parse', epic.branch)).toBe(epic.base)
  await expect(git('rev-parse', '--verify', '--quiet', `refs/heads/corral/candidates/${op!.id}`)).rejects.toThrow()
})

it('integrates once CI passes the candidate', async () => {
  await t.db.update(schema.projects).set({ requiredChecks: ['ci'] }).where(eq(schema.projects.id, project.id))
  const epic = await createEpic()
  const task = await approved(epic, 'a.txt')
  await tick()
  const candidate = (await ops(epic.id))[0]!.resultHeadSha!
  t.github.setChecks(candidate, [{ name: 'ci', conclusion: 'success', url: null }])
  await tick()
  expect(await row(task)).toMatchObject({ status: 'merged', mergeCommitSha: candidate })
  expect(await git('rev-parse', epic.branch)).toBe(candidate)
})

it('needs no task PR when CI only runs on the epic PR, and leaves those checks to its merge', async () => {
  await t.db.update(schema.projects).set({ requiredChecks: ['pr-only'] }).where(eq(schema.projects.id, project.id))
  const epic = await createEpic()
  const task = await approved(epic, 'a.txt')
  await tick()
  await tick()
  expect(await row(task)).toMatchObject({ status: 'ready_to_merge' })
  t.clock.now = new Date(t.clock.now.getTime() + 4 * 60_000)
  await tick()
  expect(await row(task)).toMatchObject({ status: 'merged', prNumber: null })
  expect(t.github.calls.some(c => c.method === 'openPullRequest' && JSON.stringify(c.args).includes(task.branch))).toBe(false)
  const audit = await t.db.select().from(schema.auditLog).where(eq(schema.auditLog.taskId, task.id))
  expect(audit.some(e => e.action === 'integration.operation' && (e.detail as { event: string, error?: string }).event === 'checks_deferred' && (e.detail as { error?: string }).error === 'pr-only')).toBe(true)
})

it('fails a task over later passes when its own submission can\'t be integrated', async () => {
  const epic = await createEpic()
  const task = await approved(epic, 'a.txt')
  await t.db.update(schema.taskSubmissions).set({ baseSha: '1'.repeat(40) }).where(eq(schema.taskSubmissions.id, task.submissionId))
  await tick()
  expect(await row(task)).toMatchObject({ status: 'ready_to_merge' })
  expect(await ops(epic.id)).toMatchObject([{ state: 'failed', error: expect.stringContaining('Could not build a candidate') }])
  await tick()
  await tick()
  expect(await row(task)).toMatchObject({ status: 'failed' })
  expect((await row(task)).statusReason).toContain('Integration failed 3 times')
  expect(await git('rev-parse', epic.branch)).toBe(epic.base)
})

it('rides out a runner outage: nothing is counted against the task and a later pass integrates it', async () => {
  const epic = await createEpic()
  const task = await approved(epic, 'a.txt')
  faults = async (job, real) => {
    if ((job.kind === 'integration_prepare' || job.kind === 'integration_push') && job.targetBranch === epic.branch) throw new Error('Could not resolve host: github.com')
    return real()
  }
  for (let pass = 1; pass <= 4; pass++) {
    await tick()
    expect(await ops(epic.id)).toHaveLength(pass)
    expect(await row(task)).toMatchObject({ status: 'ready_to_merge' })
  }
  faults = async (job, real) => {
    if (job.kind === 'integration_push' && job.targetBranch === epic.branch) throw new Error('Runner disconnected')
    return real()
  }
  await tick()
  await tick()
  expect((await ops(epic.id)).at(-1)).toMatchObject({ state: 'failed', error: expect.stringContaining('Runner disconnected') })
  expect(await row(task)).toMatchObject({ status: 'ready_to_merge' })
  faults = null
  await tick()
  expect(await row(task)).toMatchObject({ status: 'merged' })
  expect(await trailers(epic.branch, task.submissionId)).toHaveLength(1)
})

it('moves nothing while paused, and carries on from the same operation afterwards', async () => {
  await t.db.update(schema.projects).set({ requiredChecks: ['ci'] }).where(eq(schema.projects.id, project.id))
  const epic = await createEpic()
  const task = await approved(epic, 'a.txt')
  await tick()
  const [op] = await ops(epic.id)
  t.github.setChecks(op!.resultHeadSha!, [{ name: 'ci', conclusion: 'pending', url: null }])
  await tick()

  await t.db.update(schema.projects).set({ paused: true }).where(eq(schema.projects.id, project.id))
  t.github.setChecks(op!.resultHeadSha!, [{ name: 'ci', conclusion: 'success', url: null }])
  await tick()
  expect(await git('rev-parse', epic.branch)).toBe(epic.base)
  expect(await row(task)).toMatchObject({ status: 'ready_to_merge' })
  expect(await ops(epic.id)).toMatchObject([{ id: op!.id, state: 'running' }])
  await t.db.update(schema.projects).set({ paused: false }).where(eq(schema.projects.id, project.id))

  await t.db.update(schema.tasks).set({ paused: true }).where(eq(schema.tasks.id, task.id))
  await tick()
  expect(await git('rev-parse', epic.branch)).toBe(epic.base)
  await t.db.update(schema.tasks).set({ paused: false }).where(eq(schema.tasks.id, task.id))

  await tick()
  expect(await row(task)).toMatchObject({ status: 'merged', mergeCommitSha: op!.resultHeadSha })
  expect(await ops(epic.id)).toHaveLength(1)
})

describe('while the kill switch or update hold is on', () => {
  let jobs: string[] = []
  const pushes = () => jobs.filter(kind => kind === 'integration_push').length
  const stop = (on: boolean) => {
    t.orchestrator.merges.stopped = on
  }
  const record = (stopAfter?: Job['kind']) => {
    faults = async (job, real) => {
      jobs.push(job.kind)
      const result = await real()
      if (job.kind === stopAfter) stop(true)
      return result
    }
  }
  // `during` runs as the checks of this commit are read
  const onChecks = (candidate: string, during: () => void) => {
    const read = t.github.checks.bind(t.github)
    vi.spyOn(t.github, 'checks').mockImplementation(async (repository, sha) => {
      if (sha === candidate) during()
      return read(repository, sha)
    })
  }
  beforeEach(() => {
    jobs = []
    record()
  })
  afterEach(() => {
    stop(false)
    vi.restoreAllMocks()
  })

  it('holds a candidate that finished preparing as the stop began, then pushes that same candidate', async () => {
    const epic = await createEpic()
    const task = await approved(epic, 'a.txt')
    record('integration_prepare')
    await tick()
    await tick()
    expect(pushes()).toBe(0)
    expect(await git('rev-parse', epic.branch)).toBe(epic.base)
    expect(await row(task)).toMatchObject({ status: 'ready_to_merge', mergedAt: null })
    const [held] = await ops(epic.id)
    expect(held).toMatchObject({ state: 'running', error: null, resultHeadSha: expect.any(String) })

    stop(false)
    await tick()
    expect(pushes()).toBe(1)
    expect(await ops(epic.id)).toMatchObject([{ id: held!.id, state: 'succeeded', resultHeadSha: held!.resultHeadSha }])
    expect(await row(task)).toMatchObject({ status: 'merged', mergeCommitSha: held!.resultHeadSha })
    expect(await git('rev-parse', epic.branch)).toBe(held!.resultHeadSha)
    expect(await trailers(epic.branch, task.submissionId)).toHaveLength(1)
  })

  it('holds a candidate whose checks passed as the stop began, then pushes it', async () => {
    await t.db.update(schema.projects).set({ requiredChecks: ['ci'] }).where(eq(schema.projects.id, project.id))
    const epic = await createEpic()
    const task = await approved(epic, 'a.txt')
    await tick()
    const [op] = await ops(epic.id)
    t.github.setChecks(op!.resultHeadSha!, [{ name: 'ci', conclusion: 'pending', url: null }])
    await tick()

    t.github.setChecks(op!.resultHeadSha!, [{ name: 'ci', conclusion: 'success', url: null }])
    onChecks(op!.resultHeadSha!, () => stop(true))
    await tick()
    expect(pushes()).toBe(0)
    expect(await git('rev-parse', epic.branch)).toBe(epic.base)
    expect(await ops(epic.id)).toMatchObject([{ id: op!.id, state: 'running' }])

    vi.restoreAllMocks()
    stop(false)
    await tick()
    expect(pushes()).toBe(1)
    expect(await ops(epic.id)).toMatchObject([{ id: op!.id, state: 'succeeded' }])
    expect(await row(task)).toMatchObject({ status: 'merged', mergeCommitSha: op!.resultHeadSha })
  })

  it('waits for the stop to end before acting on a failure read during it', async () => {
    await t.db.update(schema.projects).set({ requiredChecks: ['ci'] }).where(eq(schema.projects.id, project.id))
    const epic = await createEpic()
    const task = await approved(epic, 'a.txt')
    await tick()
    const [op] = await ops(epic.id)
    t.github.setChecks(op!.resultHeadSha!, [{ name: 'ci', conclusion: 'failure', url: null }])
    onChecks(op!.resultHeadSha!, () => stop(true))
    await tick()
    expect(await row(task)).toMatchObject({ status: 'ready_to_merge' })
    expect(await ops(epic.id)).toMatchObject([{ id: op!.id, state: 'running' }])

    vi.restoreAllMocks()
    stop(false)
    await tick()
    expect(await row(task)).toMatchObject({ status: 'in_progress' })
  })

  it('puts an operation back when the stop begins as its push is journaled', async () => {
    await t.db.update(schema.projects).set({ requiredChecks: ['ci'] }).where(eq(schema.projects.id, project.id))
    const epic = await createEpic()
    const task = await approved(epic, 'a.txt')
    await tick()
    const [waiting] = await ops(epic.id)
    t.github.setChecks(waiting!.resultHeadSha!, [{ name: 'ci', conclusion: 'success', url: null }])
    // Off for the look straight after the checks, on for the last one before the push
    let read = false
    let looks = 0
    onChecks(waiting!.resultHeadSha!, () => {
      read = true
    })
    const integrator = new TaskIntegrator({ db: t.db, events: t.bus, github: t.github, runner: t.runner }, async () => {})
    await integrator.tick(() => read && ++looks > 1)
    expect(pushes()).toBe(0)
    expect(await git('rev-parse', epic.branch)).toBe(epic.base)
    // Back as it was: not a push of unknown result, and its checks keep their age
    expect(await ops(epic.id)).toMatchObject([{ id: waiting!.id, state: 'running', updatedAt: waiting!.updatedAt }])

    vi.restoreAllMocks()
    await tick()
    expect(await row(task)).toMatchObject({ status: 'merged', mergeCommitSha: waiting!.resultHeadSha })
    expect(await ops(epic.id)).toHaveLength(1)
  })
})

it('leaves a pending operation alone while paused', async () => {
  const epic = await createEpic()
  const task = await approved(epic, 'a.txt')
  await t.db.insert(schema.taskIntegrationOperations).values({ submissionId: task.submissionId, epicId: epic.id, kind: 'integrate', expectedTargetSha: epic.base, leaseEpoch: 1 })
  await t.db.update(schema.tasks).set({ paused: true }).where(eq(schema.tasks.id, task.id))
  await tick()
  expect(await ops(epic.id)).toMatchObject([{ state: 'pending', runnerId: null }])
  await t.db.update(schema.tasks).set({ paused: false }).where(eq(schema.tasks.id, task.id))
  await tick()
  expect(await row(task)).toMatchObject({ status: 'merged' })
})

it('drops an operation whose task was sent back before the push', async () => {
  await t.db.update(schema.projects).set({ requiredChecks: ['ci'] }).where(eq(schema.projects.id, project.id))
  const epic = await createEpic()
  const task = await approved(epic, 'a.txt')
  await tick()
  const candidate = (await ops(epic.id))[0]!.resultHeadSha!
  await t.db.update(schema.tasks).set({ status: 'in_progress' }).where(eq(schema.tasks.id, task.id))
  t.github.setChecks(candidate, [{ name: 'ci', conclusion: 'success', url: null }])
  await tick()
  expect((await ops(epic.id))[0]).toMatchObject({ state: 'failed', error: 'The task left Ready to merge' })
  expect(await git('rev-parse', epic.branch)).toBe(epic.base)
})

it('wakes same-epic dependents on integration, and others only when the epic reaches the target branch', async () => {
  const epic = await createEpic()
  const other = await createEpic()
  const task = await approved(epic, 'a.txt')
  const approve = (n: number) => t.request('POST', `/api/projects/${project.slug}/tasks/${n}/transitions`, { type: 'approve' })
  const same = await t.createTask(project.slug, { epicId: epic.id, dependsOn: [task.number] })
  const elsewhere = await t.createTask(project.slug, { epicId: other.id, dependsOn: [task.number] })
  const standalone = await t.createTask(project.slug, { dependsOn: [task.number] })
  for (const dependent of [same, elsewhere, standalone]) await approve(dependent.number)
  await t.db.update(schema.agents).set({ concurrency: 50, wakeIntervalSeconds: null })

  // Approval and a pending integration satisfy nothing
  await t.orchestrator.schedule()
  expect(await row(same)).toMatchObject({ status: 'ready' })
  const seen = t.events.length
  await tick()
  await t.orchestrator.schedule()
  expect(await row(task)).toMatchObject({ status: 'merged' })
  expect(t.events.slice(seen).some(e => e.type === 'task.updated' && e.task.id === same.id)).toBe(true)
  expect(await row(same)).toMatchObject({ status: 'in_progress' })
  expect(await row(elsewhere)).toMatchObject({ status: 'ready' })
  expect(await row(standalone)).toMatchObject({ status: 'ready' })

  await t.db.update(schema.epics).set({ reviewState: 'merged' }).where(eq(schema.epics.id, epic.id))
  expect(await publishEpicDependents(t.db, t.bus, epic.id)).toEqual(expect.arrayContaining([elsewhere.id, standalone.id]))
  await t.orchestrator.schedule()
  expect(await row(elsewhere)).toMatchObject({ status: 'in_progress' })
  expect(await row(standalone)).toMatchObject({ status: 'in_progress' })
})
