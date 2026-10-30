import { randomUUID } from 'node:crypto'
import { mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type { RunnerMessage, RunJob } from '@corral/contracts'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentExit, AgentRuntime } from './agent-runtime.ts'
import { loadConfig, type RunnerConfig } from './config.ts'
import type { ServerConnection } from './connection.ts'
import { git } from './exec.ts'
import { runSetupJob } from './jobs.ts'
import type { ToolServer } from './mcp.ts'
import { barePath } from './repos.ts'
import { RunManager } from './run-manager.ts'
import { createTestDataDir, pmJob, TEST_REPOSITORY } from './test-repo.ts'
import { pmWorktreePath, prepareWorkspace, worktreePath } from './workspace.ts'

const PROJECT = randomUUID()

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false)
}

describe('sweep_worktrees', () => {
  let dataDir: string
  let config: RunnerConfig

  beforeEach(async () => {
    dataDir = await createTestDataDir()
    config = { ...loadConfig({}), dataDir }
  })

  afterEach(async () => {
    await rm(dirname(dataDir), { recursive: true, force: true })
  })

  function sweep(keepTaskIds: string[], keepPlanSessionIds: string[], pmTurnRunning?: (id: string) => boolean) {
    return runSetupJob(config, { kind: 'sweep_worktrees', keepTaskIds, keepPlanSessionIds }, pmTurnRunning)
  }

  async function prepare(job: Partial<RunJob>): Promise<void> {
    const prepared = await prepareWorkspace(dataDir, pmJob({ projectId: PROJECT, ...job }))
    expect(prepared.error).toBeNull()
  }

  async function developer(taskId: string): Promise<string> {
    await prepare({ role: 'developer', taskId, branch: `corral/${taskId}`, planSessionId: null })
    return worktreePath(dataDir, taskId, 'developer')
  }

  async function reviewer(taskId: string): Promise<string> {
    await prepare({ role: 'reviewer', taskId, planSessionId: null })
    return worktreePath(dataDir, taskId, 'reviewer')
  }

  async function pm(planSessionId: string): Promise<string> {
    await prepare({ planSessionId })
    return pmWorktreePath(dataDir, PROJECT, planSessionId)
  }

  it('removes what is outside the keep lists, from disk and from the bare clone', async () => {
    const [a, b, s1, s2] = [randomUUID(), randomUUID(), randomUUID(), randomUUID()]
    const stay = [await developer(a), await reviewer(a), await pm(s1)]
    const go = [await developer(b), await reviewer(b), await pm(s2)]

    const result = await sweep([a], [s1])

    expect(result).toEqual({ kind: 'sweep_worktrees', removed: expect.arrayContaining(go), kept: [] })
    expect(result).toHaveProperty('removed.length', 3)
    for (const path of stay) expect(await exists(path)).toBe(true)
    for (const path of go) expect(await exists(path)).toBe(false)
    const list = await git(['worktree', 'list', '--porcelain'], { cwd: barePath(dataDir, TEST_REPOSITORY) })
    for (const path of stay) expect(list.stdout).toContain(path)
    for (const path of go) expect(list.stdout).not.toContain(path)
  })

  it('keeps a developer worktree with uncommitted changes and reports it', async () => {
    const path = await developer(randomUUID())
    await writeFile(join(path, 'work.txt'), 'not committed\n')
    expect(await sweep([], [])).toEqual({ kind: 'sweep_worktrees', removed: [], kept: [path] })
    expect(await exists(join(path, 'work.txt'))).toBe(true)
  })

  it('force-removes review and pm worktrees with uncommitted changes', async () => {
    const paths = [await reviewer(randomUUID()), await pm(randomUUID())]
    for (const path of paths) await writeFile(join(path, 'scribble.txt'), 'x\n')
    const result = await sweep([], [])
    expect(result).toEqual({ kind: 'sweep_worktrees', removed: expect.arrayContaining(paths), kept: [] })
    for (const path of paths) expect(await exists(path)).toBe(false)
  })

  it('deletes an orphan folder with no repository, even inside a git checkout', async () => {
    // pnpm dev keeps the data dir inside a checkout, whose status is not the orphan's
    await git(['init', '--quiet'], { cwd: dirname(dataDir) })
    await writeFile(join(dirname(dataDir), 'dirty.txt'), 'x\n')
    const path = join(dataDir, 'worktrees', randomUUID())
    await mkdir(path, { recursive: true })
    await writeFile(join(path, 'left.txt'), 'x\n')
    expect(await sweep([], [])).toEqual({ kind: 'sweep_worktrees', removed: [path], kept: [] })
    expect(await exists(path)).toBe(false)
  })

  it('deletes an orphan whose .git points at a clone that is gone', async () => {
    const path = join(dataDir, 'worktrees', `${randomUUID()}-review`)
    await mkdir(path, { recursive: true })
    await writeFile(join(path, '.git'), `gitdir: ${join(dataDir, 'repos', 'gone.git', 'worktrees', 'x')}\n`)
    expect(await sweep([], [])).toEqual({ kind: 'sweep_worktrees', removed: [path], kept: [] })
  })

  it('keeps an orphan repository with uncommitted changes and deletes a clean one', async () => {
    const dirty = join(dataDir, 'worktrees', randomUUID())
    const clean = join(dataDir, 'worktrees', randomUUID())
    for (const path of [dirty, clean]) {
      await mkdir(path, { recursive: true })
      await git(['init', '--quiet'], { cwd: path })
    }
    await writeFile(join(dirty, 'work.txt'), 'x\n')
    expect(await sweep([], [])).toEqual({ kind: 'sweep_worktrees', removed: [clean], kept: [dirty] })
  })

  it('leaves names that match neither pattern alone', async () => {
    const root = join(dataDir, 'worktrees')
    const names = ['notes', 'pm-project-1-session-1', `${randomUUID()}-backup`, `pm-${randomUUID()}`]
    for (const name of names) await mkdir(join(root, name), { recursive: true })
    await writeFile(join(root, randomUUID()), 'a file, not a folder')
    expect(await sweep([], [])).toEqual({ kind: 'sweep_worktrees', removed: [], kept: [] })
    expect(await readdir(root)).toHaveLength(names.length + 1)
  })

  it('does nothing when there are no worktrees yet', async () => {
    expect(await sweep([], [])).toEqual({ kind: 'sweep_worktrees', removed: [], kept: [] })
  })

  it('fails without removing anything when a bare clone cannot list its worktrees', async () => {
    const path = await developer(randomUUID())
    await mkdir(join(dataDir, 'repos', 'broken.git'))
    await expect(sweep([], [])).rejects.toThrow('broken.git')
    expect(await exists(path)).toBe(true)
  })

  it('never removes the pm worktree of a turn running on the runner', async () => {
    const sent: RunnerMessage[] = []
    const connection = { send: (message: RunnerMessage) => sent.push(message) > 0 } as unknown as ServerConnection
    const tools = { register: () => () => {}, url: () => 'http://127.0.0.1:9/mcp' } as unknown as ToolServer
    let finish!: (exit: AgentExit) => void
    const runtime: AgentRuntime = {
      id: 'fake',
      spawn: (options) => {
        options.onLine('{}', { events: [], sessionId: 'fake-session', rateLimit: null, result: null })
        return { pid: -1, exited: new Promise(resolve => (finish = resolve)), kill: () => {} }
      }
    }
    const manager = new RunManager({ ...config, pmWarmSeconds: 0 }, connection, tools, new Map([['fake', runtime]]))
    const session = randomUUID()
    const path = pmWorktreePath(dataDir, PROJECT, session)
    manager.assign(pmJob({ runtime: 'fake', projectId: PROJECT, planSessionId: session }))
    await expect.poll(() => sent.some(m => m.type === 'run.started'), { timeout: 10_000 }).toBe(true)

    const pmTurnRunning = (id: string) => manager.pmTurnRunning(id)
    expect(await sweep([], [], pmTurnRunning)).toEqual({ kind: 'sweep_worktrees', removed: [], kept: [] })
    expect(await exists(path)).toBe(true)

    // Once the turn is over nothing protects it
    finish({ code: 0, signal: null })
    await expect.poll(() => sent.some(m => m.type === 'run.ended')).toBe(true)
    expect(await sweep([], [], pmTurnRunning)).toEqual({ kind: 'sweep_worktrees', removed: [path], kept: [] })
  })
})
