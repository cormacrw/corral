import type { RunnerMessage } from '@corral/contracts'
import { chmod, mkdir, readdir, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentExit, AgentRuntime, AgentSession, ParsedLine } from './agent-runtime.ts'
import type { RunnerConfig } from './config.ts'
import type { ServerConnection } from './connection.ts'
import type { ToolServer } from './mcp.ts'
import { RunManager } from './run-manager.ts'
import { createTestDataDir, pmJob } from './test-repo.ts'

describe('RunManager and the files a run leaves', () => {
  let dataDir: string
  let config: RunnerConfig
  let sent: RunnerMessage[]
  let up: boolean
  let scratch: string | null
  let line: ((raw: string, parsed: ParsedLine) => void) | null
  let unregistered: number
  const connection = { send: (message: RunnerMessage) => up && sent.push(message) > 0 } as unknown as ServerConnection
  const tools = {
    register: () => () => void unregistered++,
    url: () => 'http://127.0.0.1:9/mcp'
  } as unknown as ToolServer
  const parsed: ParsedLine = { events: [], sessionId: 'fake-session', rateLimit: null, result: null }

  // Leaves a read-only design copy in its scratch folder, as saveDesign does
  const runtime: AgentRuntime = {
    id: 'fake',
    spawn: (options) => {
      scratch = dirname(options.mcpConfigPath)
      line = options.onLine
      options.onLine('{}', parsed)
      const design = join(scratch, 'designs', 'APP-1-v1')
      const exited = (async (): Promise<AgentExit> => {
        await mkdir(design, { recursive: true })
        await writeFile(join(design, 'design.md'), '# Design')
        await chmod(design, 0o555)
        return { code: 0, signal: null }
      })()
      return { pid: -1, exited, kill: () => {} }
    }
  }

  const manager = (runtimes: AgentRuntime = runtime, pmWarmSeconds = 0) => new RunManager({ ...config, pmWarmSeconds }, connection, tools, new Map([['fake', runtimes]]))
  const developer = () => pmJob({ runId: 'r1', role: 'reviewer', runtime: 'fake', planSessionId: null, taskId: 'task-1', taskRef: 'APP-1', branch: 'corral/app-1', headSha: 'HEAD' })
  const present = (path: string) => stat(path).then(() => true, () => false)
  const spool = (runId: string) => join(dataDir, 'spool', `${runId}.jsonl`)

  beforeEach(async () => {
    dataDir = await createTestDataDir()
    config = { dataDir, claudeBin: '/nonexistent/claude', codexBin: '/nonexistent/codex', name: 'test', serverUrl: new URL('http://127.0.0.1:9'), gitAuthor: null, pmWarmSeconds: 0, titleModel: 'haiku', slots: 4, roles: ['pm', 'developer', 'reviewer', 'design'] }
    sent = []
    up = true
    scratch = null
    line = null
    unregistered = 0
  })

  afterEach(async () => {
    await rm(dirname(dataDir), { recursive: true, force: true })
  })

  it('removes the scratch folder, read-only files included, and the spool once run.ended has gone out', async () => {
    manager().assign(pmJob({ runId: 'r1', role: 'pm', runtime: 'fake', planSessionId: 's1' }))
    await expect.poll(() => sent.some(m => m.type === 'run.ended'), { timeout: 10_000 }).toBe(true)

    await expect.poll(() => present(scratch!)).toBe(false)
    await expect.poll(() => present(spool('r1'))).toBe(false)
  })

  it('keeps them until run.ended has really been handed over', async () => {
    up = false
    const runs = manager()
    runs.assign(pmJob({ runId: 'r1', role: 'pm', runtime: 'fake', planSessionId: 's1' }))
    await expect.poll(() => scratch, { timeout: 10_000 }).toBeTruthy()
    await runs.shutdown()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(await present(scratch!)).toBe(true)

    up = true
    runs.handle({ type: 'welcome', runnerId: 'r', commit: 'c', draining: false, updateRequested: false })

    await expect.poll(() => present(scratch!)).toBe(false)
  })

  it('keeps a warm session\'s scratch folder for its next turn', async () => {
    const session: AgentRuntime = {
      id: 'fake',
      spawn: () => { throw new Error('Not used') },
      spawnSession: (options) => {
        scratch = dirname(options.mcpConfigPath)
        return {
          pid: -1,
          exited: new Promise<AgentExit>(() => {}),
          kill: () => {},
          send: () => options.onLine('{}', parsed),
          message: () => false,
          close: () => {},
          nextResult: () => Promise.resolve({ isError: false, text: 'Done' }),
          nextIdle: () => Promise.resolve(null)
        } satisfies AgentSession
      }
    }
    const runs = manager(session, 300)
    runs.assign(pmJob({ runId: 'r1', role: 'pm', runtime: 'fake', planSessionId: 's1' }))
    await expect.poll(() => sent.some(m => m.type === 'run.ended'), { timeout: 10_000 }).toBe(true)
    await new Promise(resolve => setTimeout(resolve, 100))

    expect(scratch).toContain('pm-project-1-s1')
    expect(await present(scratch!)).toBe(true)
    expect(await present(spool('r1'))).toBe(false)
  })

  it('carries on when the spool can\'t be written, and says so', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      // A folder in the way fails the open, as a full disk would
      await mkdir(spool('r1'), { recursive: true })
      let exit!: (value: AgentExit) => void
      const quiet: AgentRuntime = {
        id: 'fake',
        spawn: (options) => {
          line = options.onLine
          options.onLine('{}', parsed)
          return { pid: -1, exited: new Promise(resolve => (exit = resolve)), kill: () => {} }
        }
      }
      manager(quiet).assign(pmJob({ runId: 'r1', role: 'pm', runtime: 'fake', planSessionId: 's1' }))
      await expect.poll(() => line, { timeout: 10_000 }).toBeTruthy()
      await new Promise(resolve => setTimeout(resolve, 100))
      line!('{"more":1}', { ...parsed, sessionId: null })
      exit({ code: 0, signal: null })
      await expect.poll(() => sent.some(m => m.type === 'run.ended'), { timeout: 10_000 }).toBe(true)

      const notes = sent.flatMap(m => m.type === 'run.events' ? m.events : []).flatMap(e => e.type === 'system' ? [e.text] : [])
      expect(notes.filter(n => n.startsWith('The runner stopped keeping a local copy'))).toHaveLength(1)
    } finally {
      warnings.mockRestore()
    }
  })

  it('unregisters the tools of a warm process that could not be started', async () => {
    const broken: AgentRuntime = {
      id: 'fake',
      spawn: () => { throw new Error('Not used') },
      spawnSession: () => { throw new Error('spawn E2BIG') }
    }
    manager(broken, 300).assign(pmJob({ runId: 'r1', role: 'pm', runtime: 'fake', planSessionId: 's1' }))

    await expect.poll(() => sent.find(m => m.type === 'run.ended'), { timeout: 10_000 }).toMatchObject({ exit: { kind: 'error', message: 'spawn E2BIG' } })
    expect(unregistered).toBe(1)
  })

  it('leaves a run\'s files alone while it is here, in the sweep\'s view', async () => {
    const runs = manager()
    expect(runs.hasRun('r1')).toBe(false)
    runs.assign(developer())
    expect(runs.hasRun('r1')).toBe(true)
    await expect.poll(() => runs.hasRun('r1'), { timeout: 10_000 }).toBe(false)
    await expect.poll(() => readdir(join(dataDir, 'spool'))).toEqual([])
  })
})
