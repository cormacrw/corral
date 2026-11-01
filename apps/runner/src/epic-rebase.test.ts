import { writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { beforeEach, expect, it, vi } from 'vitest'
import { prepareEpicRebase, pushEpicRebase } from './epic-rebase.ts'
import { exec } from './exec.ts'
import { barePath } from './repos.ts'
import { createTestDataDir, TEST_REPOSITORY as repository } from './test-repo.ts'

vi.setConfig({ testTimeout: 30_000 })

let dataDir: string
let origin: string

async function run(...args: string[]): Promise<string> {
  const result = await exec('git', ['-c', 'user.name=Dev', '-c', 'user.email=dev@example.com', ...args], { cwd: origin })
  if (result.code !== 0) throw new Error(result.stderr)
  return result.stdout.trim()
}

async function commit(branch: string, file: string, text: string): Promise<string> {
  await run('checkout', '--quiet', branch)
  await writeFile(join(origin, file), text)
  await run('add', '.')
  await run('commit', '--quiet', '-m', `Change ${file}`)
  const head = await run('rev-parse', 'HEAD')
  await run('checkout', '--quiet', 'main')
  return head
}

const prepare = (expectedHeadSha: string, ontoSha: string) => prepareEpicRebase(dataDir, null, { kind: 'epic_rebase_prepare', repository, epicBranch: 'epic', expectedHeadSha, ontoSha })
const push = (expectedHeadSha: string, ontoSha: string, candidateSha: string) => pushEpicRebase(dataDir, { kind: 'epic_rebase_push', repository, epicBranch: 'epic', targetBranch: 'main', expectedHeadSha, ontoSha, candidateSha })

beforeEach(async () => {
  vi.stubEnv('GIT_CONFIG_COUNT', '0')
  dataDir = await createTestDataDir()
  origin = join(dirname(dataDir), 'origin')
  await run('config', 'receive.denyCurrentBranch', 'ignore')
  await run('branch', 'epic', 'main')
})

it('rebases cleanly in isolation, leaving every shared ref alone until the push', async () => {
  const head = await commit('epic', 'epic.txt', 'epic\n')
  const onto = await commit('main', 'target.txt', 'target\n')
  const prepared = await prepare(head, onto)
  expect(prepared).toMatchObject({ status: 'rebased', files: [] })
  expect(await run('rev-parse', 'epic')).toBe(head)
  expect((await exec('git', ['worktree', 'list', '--porcelain'], { cwd: barePath(dataDir, repository) })).stdout).not.toContain('corral-epic-rebase')

  expect(await push(head, onto, prepared.commitSha!)).toMatchObject({ pushed: true, rejected: null })
  expect(await run('rev-parse', 'epic')).toBe(prepared.commitSha)
  expect(await run('rev-parse', 'epic^')).toBe(onto)
})

it('reports a conflict with its files and leaves nothing behind', async () => {
  await commit('main', 'shared.txt', 'line\n')
  await run('branch', '--force', 'epic', 'main')
  const head = await commit('epic', 'shared.txt', 'epic\n')
  const onto = await commit('main', 'shared.txt', 'target\n')
  expect(await prepare(head, onto)).toMatchObject({ status: 'conflict', files: ['shared.txt'], commitSha: null })
  expect(await run('rev-parse', 'epic')).toBe(head)
})

it('reports an epic that is already on the target, and one that moved', async () => {
  const head = await commit('epic', 'epic.txt', 'epic\n')
  expect(await prepare(head, await run('rev-parse', 'main'))).toMatchObject({ status: 'up_to_date', commitSha: head })
  const stale = await run('rev-parse', 'epic^')
  expect(await prepare(stale, await run('rev-parse', 'main'))).toMatchObject({ status: 'moved' })
})

it('refuses to replace a moved epic branch', async () => {
  const head = await commit('epic', 'epic.txt', 'epic\n')
  const onto = await commit('main', 'target.txt', 'target\n')
  const { commitSha } = await prepare(head, onto)
  const raced = await commit('epic', 'raced.txt', 'raced\n')
  expect(await push(head, onto, commitSha!)).toMatchObject({ pushed: false, rejected: null })
  expect(await run('rev-parse', 'epic')).toBe(raced)
})

it('rejects a candidate that drops target work, skips the target or merges it in', async () => {
  const head = await commit('epic', 'epic.txt', 'epic\n')
  const onto = await commit('main', 'target.txt', 'target\n')
  await run('checkout', '--quiet', '-b', 'candidate', onto)
  await run('cherry-pick', head)
  await run('rm', '--quiet', 'target.txt')
  await run('commit', '--quiet', '-m', 'Drop it')
  const dropped = await run('rev-parse', 'HEAD')
  await run('checkout', '--quiet', 'main')

  expect((await push(head, onto, dropped)).rejected).toContain('target.txt')
  expect((await push(head, onto, head)).rejected).toContain(`isn't rebased onto ${onto}`)
  await run('branch', 'merged', head)
  await run('checkout', '--quiet', 'merged')
  await run('merge', '--quiet', '--no-ff', '-m', 'Merge main', 'main')
  const merged = await run('rev-parse', 'HEAD')
  await run('checkout', '--quiet', 'main')
  expect((await push(head, onto, merged)).rejected).toContain('merge commits')
  expect(await run('rev-parse', 'epic')).toBe(head)
})

it('rejects a candidate that undoes a rename only the target made', async () => {
  await commit('main', 'a.txt', 'a\n')
  await run('branch', '--force', 'epic', 'main')
  const head = await commit('epic', 'c.txt', 'epic\n')
  await run('mv', 'a.txt', 'b.txt')
  await run('add', '.')
  await run('commit', '--quiet', '-m', 'Rename a to b')
  const onto = await run('rev-parse', 'HEAD')
  await run('checkout', '--quiet', '-b', 'candidate', onto)
  await run('cherry-pick', head)
  await run('mv', 'b.txt', 'a.txt')
  await run('add', '.')
  await run('commit', '--quiet', '-m', 'Put it back')
  const undone = await run('rev-parse', 'HEAD')
  await run('checkout', '--quiet', 'main')
  expect((await push(head, onto, undone)).rejected).toContain('b.txt')
  expect(await run('rev-parse', 'epic')).toBe(head)
})

// The epic edits a.txt, then the target renames it to b.txt
async function renamedUnderEpic() {
  await commit('main', 'a.txt', 'one\ntwo\nthree\nfour\nfive\nsix\n')
  await run('branch', '--force', 'epic', 'main')
  const head = await commit('epic', 'a.txt', 'one\ntwo\nthree\nfour\nfive\nsix\nepic\n')
  await run('mv', 'a.txt', 'b.txt')
  await run('add', '.')
  await run('commit', '--quiet', '-m', 'Rename a to b')
  return { head, onto: await run('rev-parse', 'HEAD') }
}

it('publishes a clean rebase that follows the target renaming a file the epic edited', async () => {
  const { head, onto } = await renamedUnderEpic()
  const prepared = await prepare(head, onto)
  expect(prepared.status).toBe('rebased')
  expect(await push(head, onto, prepared.commitSha!)).toMatchObject({ pushed: true, rejected: null })
  expect(await run('show', 'epic:b.txt')).toContain('epic')
})

// Decided: both sides changed this file, but the rename is still target work,
// and moving the edit back to a.txt would drop it
it('rejects a candidate that reverts the target renaming a file the epic edited', async () => {
  const { head, onto } = await renamedUnderEpic()
  await run('checkout', '--quiet', '-b', 'candidate', onto)
  await run('mv', 'b.txt', 'a.txt')
  await writeFile(join(origin, 'a.txt'), 'one\ntwo\nthree\nfour\nfive\nsix\nepic\n')
  await run('add', '.')
  await run('commit', '--quiet', '-m', 'Back to a')
  const reverted = await run('rev-parse', 'HEAD')
  await run('checkout', '--quiet', 'main')
  expect((await push(head, onto, reverted)).rejected).toContain('rename of a.txt to b.txt')
  expect(await run('rev-parse', 'epic')).toBe(head)
})

it('leaves a rename both sides made to the reviewer', async () => {
  await commit('main', 'a.txt', 'one\ntwo\nthree\nfour\nfive\nsix\n')
  await run('branch', '--force', 'epic', 'main')
  await run('checkout', '--quiet', 'epic')
  await run('mv', 'a.txt', 'c.txt')
  await run('add', '.')
  await run('commit', '--quiet', '-m', 'Rename a to c')
  const head = await run('rev-parse', 'HEAD')
  await run('checkout', '--quiet', 'main')
  await run('mv', 'a.txt', 'b.txt')
  await run('add', '.')
  await run('commit', '--quiet', '-m', 'Rename a to b')
  const onto = await run('rev-parse', 'HEAD')
  await run('checkout', '--quiet', '-b', 'candidate', onto)
  await run('mv', 'b.txt', 'c.txt')
  await run('add', '.')
  await run('commit', '--quiet', '-m', 'Keep c')
  const candidate = await run('rev-parse', 'HEAD')
  await run('checkout', '--quiet', 'main')
  expect(await push(head, onto, candidate)).toMatchObject({ pushed: true, rejected: null })
})

it('accepts a candidate rebased onto a later target commit than asked', async () => {
  const head = await commit('epic', 'epic.txt', 'epic\n')
  const onto = await commit('main', 'target.txt', 'one\n')
  const later = await commit('main', 'target.txt', 'two\n')
  const { commitSha } = await prepare(head, later)
  expect(await push(head, onto, commitSha!)).toMatchObject({ pushed: true })
})
