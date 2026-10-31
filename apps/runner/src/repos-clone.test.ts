import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { git } from './exec.ts'
import { barePath, syncRepository } from './repos.ts'
import { createTestDataDir, TEST_REPOSITORY } from './test-repo.ts'

describe('the first clone of a repository', () => {
  let dataDir: string
  let origin: string
  let bare: string

  beforeEach(async () => {
    dataDir = await createTestDataDir()
    origin = join(dirname(dataDir), 'origin')
    bare = barePath(dataDir, TEST_REPOSITORY)
    await rm(bare, { recursive: true, force: true })
    // GitHub's URL, answered from the local repository
    vi.stubEnv('GIT_CONFIG_COUNT', '1')
    vi.stubEnv('GIT_CONFIG_KEY_0', `url.${origin}.insteadOf`)
    vi.stubEnv('GIT_CONFIG_VALUE_0', `https://github.com/${TEST_REPOSITORY}.git`)
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(dirname(dataDir), { recursive: true, force: true })
  })

  const originBranches = async () => (await git(['for-each-ref', '--format=%(refname)', 'refs/remotes/origin'], { cwd: bare })).stdout

  it('clones, tracks origin and leaves no temporary folder', async () => {
    expect(await syncRepository(dataDir, TEST_REPOSITORY)).toBeNull()
    expect(await originBranches()).toContain('refs/remotes/origin/main')
    expect(await readdir(dirname(bare))).toEqual([`${TEST_REPOSITORY.replace('/', '__')}.git`])
  })

  it('replaces a clone that was cut off, instead of failing on it forever', async () => {
    // What SIGKILL leaves: a repository that never got its refspec
    await mkdir(bare, { recursive: true })
    await git(['init', '--quiet', '--bare', bare])
    await writeFile(join(bare, 'objects', 'partial'), '')

    expect(await syncRepository(dataDir, TEST_REPOSITORY)).toBeNull()
    expect(await originBranches()).toContain('refs/remotes/origin/main')
    expect(await stat(join(bare, 'objects', 'partial')).catch(() => null)).toBeNull()
  })

  it('removes a temporary folder left by a clone that died', async () => {
    const stale = `${bare}.tmp-dead`
    await mkdir(stale, { recursive: true })

    expect(await syncRepository(dataDir, TEST_REPOSITORY)).toBeNull()
    expect(await stat(stale).catch(() => null)).toBeNull()
  })

  it('leaves nothing behind when the clone fails', async () => {
    await rm(origin, { recursive: true, force: true })

    expect(await syncRepository(dataDir, TEST_REPOSITORY)).toEqual(expect.any(String))
    expect(await readdir(dirname(bare))).toEqual([])
  })

  it('keeps a finished clone and its worktrees', async () => {
    expect(await syncRepository(dataDir, TEST_REPOSITORY)).toBeNull()
    await writeFile(join(bare, 'marker'), '')
    expect(await syncRepository(dataDir, TEST_REPOSITORY)).toBeNull()
    expect(await stat(join(bare, 'marker')).catch(() => null)).not.toBeNull()
  })
})
