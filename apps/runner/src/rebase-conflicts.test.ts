import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { git } from './exec.ts'
import { conflictingFiles } from './repos.ts'

let repo: string
const run = async (...args: string[]) => {
  const result = await git(['-c', 'user.name=test', '-c', 'user.email=test@example.com', ...args], { cwd: repo })
  expect(result.code, result.stderr).toBe(0)
}
const commit = async (file: string, text: string) => {
  await writeFile(join(repo, file), text)
  await run('add', '.')
  await run('commit', '-m', file)
}

// Remote-tracking refs, as in the runner's bare clones
const publish = async (branch: string) => run('update-ref', `refs/remotes/origin/${branch}`, branch)

beforeEach(async () => {
  repo = await mkdtemp(join(tmpdir(), 'corral-conflicts-'))
  await run('init', '-b', 'main')
  await commit('routes.ts', 'one\n')
  await commit('docs.md', 'one\n')
  await run('checkout', '-b', 'epic')
  await commit('routes.ts', 'epic\n')
  await commit('tést.md', 'epic\n')
  await run('checkout', 'main')
})
afterEach(async () => {
  await rm(repo, { recursive: true, force: true })
})

it('names only the files both sides changed incompatibly', async () => {
  await commit('routes.ts', 'target\n')
  await commit('tést.md', 'target\n')
  await commit('other.md', 'target\n')
  await publish('main')
  await publish('epic')
  expect(await conflictingFiles(repo, 'epic', 'main')).toEqual(['routes.ts', 'tést.md'])
})

it('finds nothing when the branches apply cleanly', async () => {
  await commit('other.md', 'target\n')
  await publish('main')
  await publish('epic')
  expect(await conflictingFiles(repo, 'epic', 'main')).toEqual([])
})
