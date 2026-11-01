import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { exec } from './exec.ts'
import { inspectIntegration, prepareIntegration, pushIntegration } from './integration.ts'
import { createTestDataDir, TEST_REPOSITORY as repository } from './test-repo.ts'

let dataDir: string
let origin: string

async function run(...args: string[]): Promise<string> {
  const result = await exec('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], { cwd: origin })
  if (result.code !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

// Commits one file on a new branch from `from`; origin stays on main
async function commit(branch: string, from: string, file: string, text: string): Promise<string> {
  await run('checkout', '--quiet', '-b', branch, from)
  await writeFile(join(origin, file), text)
  await run('add', '.')
  await run('commit', '--quiet', '-m', `Change ${file}`)
  const sha = await run('rev-parse', 'HEAD')
  await run('checkout', '--quiet', 'main')
  return sha
}

const job = (submissionId: string, headSha: string, baseSha: string, expectedTargetSha: string) => ({
  kind: 'integration_prepare' as const, repository, targetBranch: 'epic', expectedTargetSha, submissionId, headSha, baseSha,
  message: `TA-1: Change\n\nCorral-Submission: ${submissionId}\n`, committedAt: '2026-10-30T12:00:00.000Z', candidateRef: null
})

async function integrate(submissionId: string, headSha: string, baseSha: string, expected: string): Promise<string> {
  const prepared = await prepareIntegration(dataDir, null, job(submissionId, headSha, baseSha, expected))
  expect(prepared.status).toBe('prepared')
  expect(await pushIntegration(dataDir, { kind: 'integration_push', repository, targetBranch: 'epic', expectedTargetSha: expected, candidateSha: prepared.commitSha! })).toMatchObject({ pushed: true })
  return prepared.commitSha!
}

let tip: string
beforeEach(async () => {
  // An agent running these tests has a push URL that always fails
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  dataDir = await createTestDataDir()
  origin = join(dirname(dataDir), 'origin')
  await run('branch', 'epic', 'main')
  tip = await run('rev-parse', 'main')
})

it('puts a task on the epic branch as one commit with its author, leaving the task branch as reviewed', async () => {
  await commit('task-a', 'epic', 'a.txt', 'a\n')
  await run('checkout', '--quiet', 'task-a')
  await writeFile(join(origin, 'a2.txt'), 'more\n')
  await run('add', '.')
  await run('commit', '--quiet', '-m', 'Second commit')
  await run('checkout', '--quiet', 'main')
  const head = await run('rev-parse', 'task-a')
  const sha = await integrate('sub-a', head, tip, tip)
  expect(await run('rev-parse', 'epic')).toBe(sha)
  expect(await run('rev-list', '--count', `${tip}..epic`)).toBe('1')
  expect(await run('rev-parse', `${sha}^`)).toBe(tip)
  expect(await run('log', '-1', '--format=%an', 'epic')).toBe(await run('log', '-1', '--format=%an', 'task-a'))
  expect(await run('log', '-1', '--format=%B', 'epic')).toBe('TA-1: Change\n\nCorral-Submission: sub-a')
  expect(await run('ls-tree', '--name-only', 'epic')).toBe('README.md\na.txt\na2.txt')
  expect(await run('rev-parse', 'task-a')).toBe(head)
})

it('applies only the task\'s own change on top of an epic that moved', async () => {
  const a = await commit('task-a', 'epic', 'a.txt', 'a\n')
  const b = await commit('task-b', 'epic', 'b.txt', 'b\n')
  const first = await integrate('sub-a', a, tip, tip)
  expect(await prepareIntegration(dataDir, null, job('sub-b', b, tip, tip))).toMatchObject({ status: 'moved', targetSha: first })
  const second = await integrate('sub-b', b, tip, first)
  expect(await run('rev-parse', `${second}^`)).toBe(first)
  expect(await run('ls-tree', '--name-only', 'epic')).toBe('README.md\na.txt\nb.txt')
})

it('reports a conflict without touching the epic branch', async () => {
  const a = await commit('task-a', 'epic', 'same.txt', 'a\n')
  const b = await commit('task-b', 'epic', 'same.txt', 'b\n')
  const first = await integrate('sub-a', a, tip, tip)
  expect(await prepareIntegration(dataDir, null, job('sub-b', b, tip, first))).toMatchObject({ status: 'conflict', files: ['same.txt'], commitSha: null })
  expect(await run('rev-parse', 'epic')).toBe(first)
})

it('finds a submission already on the remote, so a retry adds no second commit', async () => {
  const a = await commit('task-a', 'epic', 'a.txt', 'a\n')
  const sha = await integrate('sub-a', a, tip, tip)
  expect(await inspectIntegration(dataDir, { kind: 'integration_inspect', repository, targetBranch: 'epic', submissionId: 'sub-a' })).toEqual({ kind: 'integration_inspect', targetSha: sha, integratedSha: sha })
  expect(await prepareIntegration(dataDir, null, job('sub-a', a, tip, sha))).toMatchObject({ status: 'integrated', commitSha: sha })
  expect(await inspectIntegration(dataDir, { kind: 'integration_inspect', repository, targetBranch: 'epic', submissionId: 'sub-other' })).toMatchObject({ integratedSha: null })
  expect(await run('rev-list', '--count', `${tip}..epic`)).toBe('1')
})

// The steps an epic rebase task's prompt gives the developer (COR-387)
it('still finds every submission after the epic branch is squashed and rebased through a conflict', async () => {
  const a = await commit('task-a', 'epic', 'same.txt', 'a\n')
  const b = await commit('task-b', 'epic', 'b.txt', 'b\n')
  const first = await integrate('sub-a', a, tip, tip)
  const second = await integrate('sub-b', b, tip, first)
  await commit('moved', 'main', 'same.txt', 'target\n')
  await run('merge', '--quiet', '--ff-only', 'moved')

  await run('checkout', '--quiet', 'epic')
  const script = 'base=$(git merge-base HEAD main) && git reset --soft "$base" && git log --format=%B "$base..ORIG_HEAD" | git -c user.name=Dev -c user.email=dev@example.com commit -F -'
  const squashed = await exec('sh', ['-c', script], { cwd: origin })
  expect(squashed.stderr).toBe('')
  expect(await run('rev-list', '--count', 'main..HEAD')).toBe('1')
  expect((await exec('git', ['rebase', 'main'], { cwd: origin })).code).toBe(1)
  await writeFile(join(origin, 'same.txt'), 'target\na\n')
  await run('add', '.')
  const resolved = await exec('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', 'rebase', '--continue'], { cwd: origin, env: { GIT_EDITOR: 'true' } })
  expect(resolved.code).toBe(0)
  expect(await run('rev-list', '--count', 'main..HEAD')).toBe('1')
  const head = await run('rev-parse', 'HEAD')
  await run('checkout', '--quiet', 'main')

  for (const [id, headSha] of [['sub-a', a], ['sub-b', b]] as const) {
    expect(await prepareIntegration(dataDir, null, job(id, headSha, tip, second))).toMatchObject({ status: 'integrated', commitSha: head, targetSha: head })
  }
  expect(await run('rev-parse', 'epic')).toBe(head)
})

it('refuses a stale runner\'s push even when its own clone still shows the old head', async () => {
  const a = await commit('task-a', 'epic', 'a.txt', 'a\n')
  const stale = await prepareIntegration(dataDir, null, job('sub-a', a, tip, tip))
  // Newer work lands from elsewhere; this clone hasn't fetched it
  await run('update-ref', 'refs/heads/epic', await commit('newer', 'epic', 'newer.txt', 'n\n'))
  const newer = await run('rev-parse', 'epic')
  const push = await pushIntegration(dataDir, { kind: 'integration_push', repository, targetBranch: 'epic', expectedTargetSha: tip, candidateSha: stale.commitSha! })
  expect(push.pushed).toBe(false)
  expect(push.error).toContain('stale info')
  expect(await run('rev-parse', 'epic')).toBe(newer)
  expect(await pushIntegration(dataDir, { kind: 'integration_push', repository, targetBranch: 'epic', expectedTargetSha: newer, candidateSha: stale.commitSha! })).toMatchObject({ pushed: false, error: expect.stringContaining('isn\'t built on') })
})

it('publishes a candidate for CI without moving the epic branch', async () => {
  const a = await commit('task-a', 'epic', 'a.txt', 'a\n')
  const prepared = await prepareIntegration(dataDir, null, { ...job('sub-a', a, tip, tip), candidateRef: 'corral/candidates/op' })
  expect(await run('rev-parse', 'corral/candidates/op')).toBe(prepared.commitSha)
  expect(await run('rev-parse', 'epic')).toBe(tip)
})

it('calls a submission it can\'t build failed, and leaves not reaching the remote as an error', async () => {
  const a = await commit('task-a', 'epic', 'a.txt', 'a\n')
  expect(await prepareIntegration(dataDir, null, job('sub-a', a, '1'.repeat(40), tip))).toMatchObject({ status: 'failed', commitSha: null, error: expect.any(String) })
  await exec('git', ['config', 'remote.origin.url', '/nowhere'], { cwd: join(dataDir, 'repos', 'acme__app.git') })
  await expect(prepareIntegration(dataDir, null, job('sub-a', a, tip, tip))).rejects.toThrow()
})

it('calls a change the epic already has empty', async () => {
  const a = await commit('task-a', 'epic', 'a.txt', 'a\n')
  const copy = await commit('task-b', 'epic', 'a.txt', 'a\n')
  const first = await integrate('sub-a', a, tip, tip)
  expect(await prepareIntegration(dataDir, null, job('sub-b', copy, tip, first))).toMatchObject({ status: 'empty' })
})
