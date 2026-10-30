import type { RunJob, RunnerMessage } from '@corral/contracts'
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentExit, AgentRuntime } from './agent-runtime.ts'
import type { RunnerConfig } from './config.ts'
import type { ServerConnection } from './connection.ts'
import { git } from './exec.ts'
import type { ToolServer } from './mcp.ts'
import { RunManager } from './run-manager.ts'
import { createTestDataDir, pmJob } from './test-repo.ts'
import { prepareWorkspace, saveStoppedWork, worktreePath } from './workspace.ts'

const BRANCH = 'corral/app-1'
const AUTHOR = { name: 'Corral Test', email: 'corral@example.com' }

describe('a stopped run keeps its work', () => {
  let dataDir: string
  let origin: string
  let config: RunnerConfig
  let sent: RunnerMessage[]
  // What the agent leaves in its worktree before it is stopped
  let writes: Record<string, string>
  let cwds: string[]
  let exit: (value: AgentExit) => void
  const connection = { connected: true, send: (message: RunnerMessage) => sent.push(message) > 0 } as unknown as ServerConnection
  const tools = { register: () => () => {}, url: () => 'http://127.0.0.1:9/mcp' } as unknown as ToolServer

  const runtime: AgentRuntime = {
    id: 'fake',
    spawn: (options) => {
      cwds.push(options.cwd)
      options.onLine('{}', { events: [], sessionId: 'fake-session', rateLimit: null, result: null })
      const done = new Promise<AgentExit>(resolve => (exit = resolve))
      const wrote = Promise.all(Object.entries(writes).map(([name, text]) => writeFile(join(options.cwd, name), text)))
      return {
        pid: -1,
        exited: wrote.then(() => done),
        kill: signal => exit({ code: null, signal })
      }
    }
  }

  const developer = (overrides: Partial<RunJob> = {}) => pmJob({ runId: 'r1', runNumber: 7, role: 'developer', runtime: 'fake', planSessionId: null, taskId: 'task-1', taskRef: 'APP-1', branch: BRANCH, ...overrides })

  async function start(job: RunJob): Promise<RunManager> {
    const manager = new RunManager(config, connection, tools, new Map([['fake', runtime]]))
    manager.assign(job)
    await expect.poll(() => sent.some(m => m.type === 'run.started' && m.runId === job.runId), { timeout: 10_000 }).toBe(true)
    manager.handle({ type: 'run.lease', runId: job.runId, leaseEpoch: job.leaseEpoch, validUntil: new Date(Date.now() + 240_000).toISOString() })
    return manager
  }

  async function ended(runId = 'r1') {
    await expect.poll(() => sent.some(m => m.type === 'run.ended' && m.runId === runId), { timeout: 10_000 }).toBe(true)
    return sent.find(m => m.type === 'run.ended' && m.runId === runId) as Extract<RunnerMessage, { type: 'run.ended' }>
  }

  const onOrigin = async (ref: string) => (await git(['rev-parse', '--verify', '--quiet', ref], { cwd: origin })).stdout.trim() || null

  beforeEach(async () => {
    // An agent running these tests has a push URL that always fails
    vi.stubEnv('GIT_CONFIG_COUNT', '0')
    dataDir = await createTestDataDir()
    origin = join(dirname(dataDir), 'origin')
    config = { dataDir, claudeBin: '/nonexistent/claude', codexBin: '/nonexistent/codex', name: 'test', serverUrl: new URL('http://127.0.0.1:9'), gitAuthor: AUTHOR, pmWarmSeconds: 0, titleModel: 'haiku', slots: 4, roles: ['pm', 'developer', 'reviewer', 'design'] }
    sent = []
    writes = { 'feature.txt': 'half done\n' }
    cwds = []
  })

  afterEach(async () => {
    vi.unstubAllEnvs()
    await rm(dirname(dataDir), { recursive: true, force: true })
  })

  it.each([
    ['the time limit', (m: RunManager) => m.stop('r1', 'timed_out', '60 s'), 'stopped: Time limit reached'],
    ['a human', (m: RunManager) => m.handle({ type: 'run.stop', runId: 'r1', reason: 'Stopped by a human', keepWork: true }), 'stopped: Stopped by a human'],
    ['a runner shutdown', (m: RunManager) => void m.shutdown(), 'stopped: The runner shut down']
  ])('commits and pushes uncommitted work on a stop by %s', async (_name, stop, subject) => {
    stop(await start(developer()))
    const end = await ended()

    expect(end.wipSha).toMatch(/^[0-9a-f]{40}$/)
    expect(await onOrigin(BRANCH)).toBe(end.wipSha)
    expect(end.headSha).toBe(end.wipSha)
    const log = await git(['log', '-1', '--format=%an <%ae>%n%s', BRANCH], { cwd: origin })
    expect(log.stdout).toContain('Corral Test <corral@example.com>')
    expect(log.stdout).toContain(`WIP: APP-1 run #7 ${subject}`)
    expect((await git(['show', `${BRANCH}:feature.txt`], { cwd: origin })).stdout).toBe('half done\n')
    // The transcript says so, ahead of run.ended
    const note = sent.findIndex(m => m.type === 'run.events' && m.events.some(e => e.type === 'system' && e.text.startsWith('Saved the uncommitted work as WIP commit')))
    expect(note).toBeGreaterThan(-1)
    expect(note).toBeLessThan(sent.indexOf(end))
  })

  it('saves the work of an agent killed from outside Corral', async () => {
    await start(developer())
    await expect.poll(() => readFile(join(worktreePath(dataDir, 'task-1', 'developer'), 'feature.txt'), 'utf8').catch(() => null)).toBe('half done\n')
    exit({ code: 137, signal: null })
    // The one resume to report dies the same way
    await expect.poll(() => cwds.length, { timeout: 10_000 }).toBe(2)
    exit({ code: 137, signal: null })

    const end = await ended()
    expect(end.exit).toEqual({ kind: 'signalled', signal: 'SIGKILL' })
    expect(await onOrigin(BRANCH)).toBe(end.wipSha)
  })

  it('keeps WIP local after sleep even when the socket still looks connected', async () => {
    const manager = await start(developer())
    manager.handle({ type: 'run.lease', runId: 'r1', leaseEpoch: 1, validUntil: new Date(Date.now() - 1).toISOString() })
    manager.stop('r1', 'timed_out', '60 s')

    expect((await ended()).wipSha).toBeNull()
    expect(await onOrigin(BRANCH)).toBeNull()
    const path = worktreePath(dataDir, 'task-1', 'developer')
    expect((await git(['log', '-1', '--format=%s'], { cwd: path })).stdout).toContain('WIP:')
    expect((await git(['show', 'HEAD:feature.txt'], { cwd: path })).stdout).toBe('half done\n')
  })

  it('revokes a recent acknowledgement even if the time limit stopped it first', async () => {
    const manager = await start(developer())
    manager.stop('r1', 'timed_out', '60 s')
    manager.handle({ type: 'run.stop', runId: 'r1', reason: 'This run no longer holds its lease' })
    // An acknowledgement already in transit cannot restore revoked permission.
    manager.handle({ type: 'run.lease', runId: 'r1', leaseEpoch: 1, validUntil: new Date(Date.now() + 240_000).toISOString() })
    expect((await ended()).wipSha).toBeNull()
    expect(await onOrigin(BRANCH)).toBeNull()
  })

  it('pushes nothing when the worktree is clean', async () => {
    writes = {}
    const manager = await start(developer())
    manager.stop('r1', 'timed_out', '60 s')

    expect((await ended()).wipSha).toBeNull()
    expect(await onOrigin(BRANCH)).toBeNull()
    expect(sent.some(m => m.type === 'run.events' && m.events.some(e => e.type === 'system' && e.text.includes('WIP')))).toBe(false)
  })

  it('pushes nothing for a stop that does not ask to keep the work', async () => {
    const manager = await start(developer())
    manager.handle({ type: 'run.stop', runId: 'r1', reason: 'This run no longer holds its lease' })

    expect((await ended()).wipSha).toBeNull()
    expect(await onOrigin(BRANCH)).toBeNull()
  })

  it('leaves a reviewer run alone', async () => {
    const head = await onOrigin('main')
    const manager = await start(developer({ role: 'reviewer', headSha: head }))
    manager.handle({ type: 'run.stop', runId: 'r1', reason: 'Stopped by a human', keepWork: true })

    expect(await ended()).toMatchObject({ wipSha: null, headSha: null })
    expect(await onOrigin(BRANCH)).toBeNull()
    expect((await git(['log', '--format=%s'], { cwd: worktreePath(dataDir, 'task-1', 'reviewer') })).stdout.trim()).toBe('Initial commit')
  })

  it('leaves a PM run alone', async () => {
    const manager = await start(pmJob({ runId: 'r1', runtime: 'fake' }))
    manager.handle({ type: 'run.stop', runId: 'r1', reason: 'Stopped by a human', keepWork: true })

    expect(await ended()).toMatchObject({ wipSha: null, headSha: null })
    expect((await git(['for-each-ref', '--format=%(refname:short)', 'refs/heads'], { cwd: origin })).stdout.trim()).toBe('main')
  })

  it('starts the next run from the WIP commit, after a stop still saving', async () => {
    const manager = await start(developer())
    manager.handle({ type: 'run.stop', runId: 'r1', reason: 'Stopped by a human', keepWork: true })
    writes = {}
    manager.assign(developer({ runId: 'r2', runNumber: 8 }))
    const end = await ended()

    await expect.poll(() => cwds.length, { timeout: 10_000 }).toBe(2)
    expect((await git(['rev-parse', 'HEAD'], { cwd: cwds[1]! })).stdout.trim()).toBe(end.wipSha)
    expect((await git(['status', '--porcelain'], { cwd: cwds[1]! })).stdout).toBe('')
  })

  describe('saveStoppedWork', () => {
    async function worktree(): Promise<string> {
      const prepared = await prepareWorkspace(dataDir, developer())
      return prepared.workspace!.path
    }

    it('clears a lock a killed agent left behind', async () => {
      const path = await worktree()
      await writeFile(join(path, 'feature.txt'), 'x\n')
      const lock = (await git(['rev-parse', '--git-path', 'index.lock'], { cwd: path })).stdout.trim()
      await writeFile(lock, '')

      expect(await saveStoppedWork(path, BRANCH, 'WIP', AUTHOR, 5_000)).toMatchObject({ pushed: true, error: null })
    })

    it('commits as Corral on a runner with no git identity', async () => {
      const path = await worktree()
      await writeFile(join(path, 'feature.txt'), 'x\n')
      vi.stubEnv('GIT_CONFIG_GLOBAL', '/dev/null')
      vi.stubEnv('GIT_CONFIG_SYSTEM', '/dev/null')

      expect(await saveStoppedWork(path, BRANCH, 'WIP', null, 5_000)).toMatchObject({ pushed: true })
      expect((await git(['log', '-1', '--format=%an <%ae>', BRANCH], { cwd: origin })).stdout.trim()).toBe('Corral <corral@localhost>')
    })

    it('skips commit hooks', async () => {
      const path = await worktree()
      await writeFile(join(path, 'feature.txt'), 'x\n')
      const hooks = join(path, 'failing-hooks')
      await git(['config', 'core.hooksPath', hooks], { cwd: path })
      await mkdir(hooks)
      await writeFile(join(hooks, 'pre-commit'), '#!/bin/sh\nexit 1\n', { mode: 0o755 })

      expect(await saveStoppedWork(path, BRANCH, 'WIP', AUTHOR, 5_000)).toMatchObject({ pushed: true })
    })

    it('leaves a worktree that is off the branch, such as mid-rebase', async () => {
      const path = await worktree()
      await git(['checkout', '--detach'], { cwd: path })
      await writeFile(join(path, 'feature.txt'), 'x\n')

      expect(await saveStoppedWork(path, BRANCH, 'WIP', AUTHOR, 5_000)).toEqual({ sha: null, pushed: false, error: `the worktree is not on ${BRANCH}` })
      expect(await onOrigin(BRANCH)).toBeNull()
    })

    it('keeps the commit in the worktree when the push fails', async () => {
      const path = await worktree()
      await writeFile(join(path, 'feature.txt'), 'x\n')
      await git(['remote', 'set-url', 'origin', join(dataDir, 'missing')], { cwd: path })

      const saved = await saveStoppedWork(path, BRANCH, 'WIP', AUTHOR, 5_000)
      expect(saved).toMatchObject({ pushed: false, error: expect.any(String) })
      expect(saved.sha).toBe((await git(['rev-parse', 'HEAD'], { cwd: path })).stdout.trim())
      expect((await git(['status', '--porcelain'], { cwd: path })).stdout).toBe('')
    })
  })

  describe('continuing on a worktree another runner left behind', () => {
    it('fast-forwards to the WIP commit', async () => {
      const path = (await prepareWorkspace(dataDir, developer())).workspace!.path
      const wip = await pushedFromElsewhere(path)

      expect((await prepareWorkspace(dataDir, developer({ continueFrom: wip }))).error).toBeNull()
      expect((await git(['rev-parse', 'HEAD'], { cwd: path })).stdout.trim()).toBe(wip)
    })

    it('fails the run rather than dropping commits that diverged', async () => {
      const path = (await prepareWorkspace(dataDir, developer())).workspace!.path
      const wip = await pushedFromElsewhere(path)
      await git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-m', 'Local'], { cwd: path })

      expect((await prepareWorkspace(dataDir, developer({ continueFrom: wip }))).error).toContain(`Could not continue from WIP commit ${wip}`)
    })

    it('leaves a worktree already past the WIP commit', async () => {
      const path = (await prepareWorkspace(dataDir, developer())).workspace!.path
      const wip = (await git(['rev-parse', 'HEAD'], { cwd: path })).stdout.trim()
      await git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit', '--allow-empty', '-m', 'Later'], { cwd: path })
      const head = (await git(['rev-parse', 'HEAD'], { cwd: path })).stdout.trim()

      expect((await prepareWorkspace(dataDir, developer({ continueFrom: wip }))).error).toBeNull()
      expect((await git(['rev-parse', 'HEAD'], { cwd: path })).stdout.trim()).toBe(head)
    })

    // A commit on the branch at origin that this worktree doesn't have yet
    async function pushedFromElsewhere(path: string): Promise<string> {
      const base = (await git(['rev-parse', 'HEAD'], { cwd: path })).stdout.trim()
      await git(['branch', BRANCH, base], { cwd: origin })
      await git(['-c', 'user.name=T', '-c', 'user.email=t@example.com', 'commit-tree', '-m', 'WIP', '-p', base, `${base}^{tree}`], { cwd: origin }).then(async (made) => {
        await git(['update-ref', `refs/heads/${BRANCH}`, made.stdout.trim()], { cwd: origin })
      })
      return (await onOrigin(BRANCH))!
    }
  })
})
