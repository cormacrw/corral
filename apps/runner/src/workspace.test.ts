import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { git } from './exec.ts'
import { createTestDataDir, pmJob } from './test-repo.ts'
import { MAX_BRIEF_CHARS, pmWorktreePath, prepareWorkspace, readProjectBrief } from './workspace.ts'

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

describe('epic task workspaces', () => {
  it('checks out an epic integration review at its exact head without a task ID', async () => {
    const dataDir = await createTestDataDir()
    const origin = join(dirname(dataDir), 'origin')
    try {
      const sha = (await git(['rev-parse', 'HEAD'], { cwd: origin })).stdout.trim()
      const result = await prepareWorkspace(dataDir, pmJob({ role: 'reviewer', taskId: null, epicId: 'epic-one', branch: 'corral/epic-one', headSha: sha }))
      expect(result.error).toBeNull()
      expect(result.workspace!.path).toBe(join(dataDir, 'worktrees', 'epic-epic-one-review'))
      expect((await git(['rev-parse', 'HEAD'], { cwd: result.workspace!.path })).stdout.trim()).toBe(sha)
      expect((await git(['symbolic-ref', '-q', 'HEAD'], { cwd: result.workspace!.path })).code).not.toBe(0)
    } finally {
      await rm(dirname(dataDir), { recursive: true, force: true })
    }
  })

  it('starts dependent work at the latest epic commit while develop stays unchanged', async () => {
    const dataDir = await createTestDataDir()
    const origin = join(dirname(dataDir), 'origin')
    try {
      expect((await git(['branch', 'develop'], { cwd: origin })).code).toBe(0)
      expect((await git(['checkout', '-b', 'corral/epic-feature'], { cwd: origin })).code).toBe(0)
      await writeFile(join(origin, 'first.txt'), 'First task squashed into the epic\n')
      await git(['add', '.'], { cwd: origin })
      // Test identity is scoped to this fixture commit, never the worktree config.
      expect((await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'First task'], { cwd: origin })).code).toBe(0)
      const tip = (await git(['rev-parse', 'HEAD'], { cwd: origin })).stdout.trim()
      const prepared = await prepareWorkspace(dataDir, pmJob({ role: 'developer', taskId: 'dependent', branch: 'corral/task-two', defaultBranch: 'develop', baseBranch: 'corral/epic-feature' }))
      expect(prepared.error).toBeNull()
      expect((await git(['rev-parse', 'HEAD'], { cwd: prepared.workspace!.path })).stdout.trim()).toBe(tip)
      expect(await readFile(join(prepared.workspace!.path, 'first.txt'), 'utf8')).toContain('First task')
      expect((await git(['rev-list', '--count', 'develop..corral/epic-feature'], { cwd: origin })).stdout.trim()).toBe('1')
    } finally {
      await rm(dirname(dataDir), { recursive: true, force: true })
    }
  })
})

describe('readProjectBrief', () => {
  let worktree: string

  beforeEach(async () => {
    worktree = await mkdtemp(join(tmpdir(), 'corral-brief-'))
  })

  afterEach(async () => {
    await rm(worktree, { recursive: true, force: true })
  })

  it('includes CORRAL.md under a brief heading and says not to read it again', async () => {
    await writeFile(join(worktree, 'CORRAL.md'), '# Corral brief\nRun with pnpm dev.\n')
    await writeFile(join(worktree, 'CLAUDE.md'), '# Claude notes\n')
    const brief = await readProjectBrief(worktree)
    expect(brief).toMatch(/^## Project brief\n/)
    expect(brief).toContain('### CORRAL.md\n\n# Corral brief\nRun with pnpm dev.')
    expect(brief).toContain('don\'t read that file again')
    expect(brief).not.toContain('Claude notes')
  })

  it('uses .corral/CORRAL.md when there is no CORRAL.md at the root', async () => {
    await mkdir(join(worktree, '.corral'))
    await writeFile(join(worktree, '.corral', 'CORRAL.md'), 'Nested brief\n')
    await writeFile(join(worktree, 'CLAUDE.md'), '# Claude notes\n')
    const brief = await readProjectBrief(worktree)
    expect(brief).toContain('### .corral/CORRAL.md\n\nNested brief')
    expect(brief).not.toContain('Claude notes')
  })

  it('falls back to CLAUDE.md when there is no CORRAL.md', async () => {
    await writeFile(join(worktree, 'CLAUDE.md'), '# Claude notes\n')
    const brief = await readProjectBrief(worktree)
    expect(brief).toContain('### CLAUDE.md\n\n# Claude notes')
  })

  it('lists the files under .corral/wiki/, including subfolders', async () => {
    await writeFile(join(worktree, 'CORRAL.md'), 'Brief\n')
    await mkdir(join(worktree, '.corral', 'wiki', 'runner'), { recursive: true })
    await writeFile(join(worktree, '.corral', 'wiki', 'setup.md'), 'Setup')
    await writeFile(join(worktree, '.corral', 'wiki', 'runner', 'leases.md'), 'Leases')
    const brief = await readProjectBrief(worktree)
    expect(brief).toContain('### Wiki pages in .corral/wiki/\n\n- runner/leases.md\n- setup.md')
    expect(brief).not.toContain('Leases')
  })

  it('lists the wiki on its own when there is no brief file', async () => {
    await mkdir(join(worktree, '.corral', 'wiki'), { recursive: true })
    await writeFile(join(worktree, '.corral', 'wiki', 'setup.md'), 'Setup')
    const brief = await readProjectBrief(worktree)
    expect(brief).toMatch(/^## Project brief\n/)
    expect(brief).toContain('- setup.md')
    expect(brief).not.toContain('### CORRAL.md')
  })

  it('reports missing docs, wiki and dependencies when none exist', async () => {
    await writeFile(join(worktree, 'README.md'), '# App\n')
    const brief = await readProjectBrief(worktree)
    expect(brief).toContain('No project brief file')
    expect(brief).toContain('.corral/wiki/ does not exist; dependencies (node_modules) are not installed in this worktree.')
  })

  it('reports an empty wiki and installed dependencies, including symlinked directories', async () => {
    await mkdir(join(worktree, '.corral', 'wiki'), { recursive: true })
    await mkdir(join(worktree, 'dependencies'))
    await symlink(join(worktree, 'dependencies'), join(worktree, 'node_modules'), 'dir')
    const brief = await readProjectBrief(worktree)
    expect(brief).toContain('.corral/wiki/ exists; dependencies (node_modules) are installed in this worktree.')
    expect(brief).not.toContain('### Wiki pages')
  })

  it('truncates a brief over the cap with a visible note', async () => {
    await writeFile(join(worktree, 'CORRAL.md'), 'x'.repeat(MAX_BRIEF_CHARS * 2))
    const brief = await readProjectBrief(worktree)
    expect(brief.length).toBeLessThan(MAX_BRIEF_CHARS + 1000)
    expect(brief).toContain('[Brief truncated: it is longer than 20,000 characters. Read CORRAL.md for the rest if you need it.]')
  })
})

// D19: a spike's jobs have no branch and no commit
describe('prepareWorkspace for spikes', () => {
  let dataDir: string

  beforeEach(async () => {
    dataDir = await createTestDataDir()
  })

  afterEach(async () => {
    await rm(dirname(dataDir), { recursive: true, force: true })
  })

  const spikeJob = (role: 'developer' | 'reviewer') => pmJob({ role, taskId: 'task-1', taskRef: 'TA-1', branch: null, headSha: null, planSessionId: null })

  it('gives the developer a detached checkout of the default branch, kept between revisions', async () => {
    const first = await prepareWorkspace(dataDir, spikeJob('developer'))
    expect(first.error).toBeNull()
    expect(first.workspace!.path).toBe(join(dataDir, 'worktrees', 'task-1'))
    expect(await git(['symbolic-ref', '-q', 'HEAD'], { cwd: first.workspace!.path })).toMatchObject({ code: 1 })
    expect(await readFile(join(first.workspace!.path, 'README.md'), 'utf8')).toBe('# App\n')
    await writeFile(join(first.workspace!.path, 'notes.md'), 'kept\n')
    const again = await prepareWorkspace(dataDir, spikeJob('developer'))
    expect(again.workspace!.path).toBe(first.workspace!.path)
    expect(await readFile(join(again.workspace!.path, 'notes.md'), 'utf8')).toBe('kept\n')
  })

  it('gives the reviewer its own detached checkout of the default branch', async () => {
    const prepared = await prepareWorkspace(dataDir, spikeJob('reviewer'))
    expect(prepared.error).toBeNull()
    expect(prepared.workspace!.path).toBe(join(dataDir, 'worktrees', 'task-1-review'))
    expect(await git(['symbolic-ref', '-q', 'HEAD'], { cwd: prepared.workspace!.path })).toMatchObject({ code: 1 })
  })

  it('still refuses a job without a task', async () => {
    expect(await prepareWorkspace(dataDir, pmJob({ role: 'developer', taskId: null, planSessionId: null }))).toEqual({ workspace: null, error: 'The job has no task' })
  })
})
