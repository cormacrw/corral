import { readFile, rm } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { git } from './exec.ts'
import { createTestDataDir, pmJob } from './test-repo.ts'
import { pmWorktreePath, prepareWorkspace } from './workspace.ts'

describe('prepareWorkspace for PM turns', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await createTestDataDir()
  })

  afterEach(async () => {
    await rm(dirname(dataDir), { recursive: true, force: true })
  })

  it('checks out each Plan session at its own path under the data dir', async () => {
    const prepared = await prepareWorkspace(dataDir, pmJob({ projectId: 'p1', planSessionId: 's1' }))
    expect(prepared.error).toBeNull()
    expect(prepared.workspace!.path).toBe(join(dataDir, 'worktrees', 'pm-p1-s1'))
    expect(prepared.workspace!.path).toBe(pmWorktreePath(dataDir, 'p1', 's1'))
    expect(await readFile(join(prepared.workspace!.path, 'README.md'), 'utf8')).toBe('# App\n')
  })

  it('prepares two sessions in the same project at the same time without git errors', async () => {
    const results = await Promise.all([
      prepareWorkspace(dataDir, pmJob({ runId: 'r1', planSessionId: 's1' })),
      prepareWorkspace(dataDir, pmJob({ runId: 'r2', planSessionId: 's2' })),
      prepareWorkspace(dataDir, pmJob({ runId: 'r3', planSessionId: 's3' }))
    ])
    expect(results.map(r => r.error)).toEqual([null, null, null])
    const paths = results.map(r => r.workspace!.path)
    expect(new Set(paths).size).toBe(3)
    for (const path of paths) {
      const status = await git(['status', '--porcelain'], { cwd: path })
      expect(status).toMatchObject({ code: 0, stdout: '' })
    }
  })

  it('reuses the same checkout for a later turn in the same session', async () => {
    const first = await prepareWorkspace(dataDir, pmJob({ runId: 'r1' }))
    const second = await prepareWorkspace(dataDir, pmJob({ runId: 'r2' }))
    expect(first.error).toBeNull()
    expect(second.error).toBeNull()
    expect(second.workspace!.path).toBe(first.workspace!.path)
  })

  it('refuses a PM job without a plan session', async () => {
    const prepared = await prepareWorkspace(dataDir, pmJob({ planSessionId: null }))
    expect(prepared).toEqual({ workspace: null, error: 'The job has no plan session' })
  })
})
