import type { AgentTool, RunEvent, RunnerMessage } from '@corral/contracts'
import { chmod, rm, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { AgentExit, AgentRuntime, ParsedLine } from './agent-runtime.ts'
import type { RunnerConfig } from './config.ts'
import type { ServerConnection } from './connection.ts'
import { git } from './exec.ts'
import type { ToolHandler, ToolServer } from './mcp.ts'
import { barePath } from './repos.ts'
import { RunManager } from './run-manager.ts'
import { createTestDataDir, pmJob, TEST_REPOSITORY } from './test-repo.ts'

const WELCOME = { type: 'welcome', runnerId: 'r', commit: 'c', draining: false, updateRequested: false } as const

describe('RunManager with the server out of reach', () => {
  let dataDir: string
  let config: RunnerConfig
  let sent: RunnerMessage[]
  let up: boolean
  let handler: ToolHandler
  let line: (parsed: Partial<ParsedLine>) => void
  let exit: (value: AgentExit) => void
  let refreshes: number
  const connection = {
    get connected() {
      return up
    },
    send: (message: RunnerMessage) => up && sent.push(message) > 0,
    refreshUpdateStatus: () => void refreshes++
  } as unknown as ServerConnection
  const tools = {
    register: (_secret: string, _role: string, call: ToolHandler) => {
      handler = call
      return () => {}
    },
    url: () => 'http://127.0.0.1:9/mcp'
  } as unknown as ToolServer
  const runtime: AgentRuntime = {
    id: 'fake',
    spawn: (options) => {
      line = parsed => options.onLine('{}', { events: [], sessionId: null, rateLimit: null, result: null, ...parsed })
      line({ sessionId: 'fake-session' })
      return { pid: -1, exited: new Promise(resolve => (exit = resolve)), kill: signal => exit({ code: null, signal }) }
    }
  }

  const reconnect = (manager: RunManager) => {
    up = true
    manager.handle(WELCOME)
  }
  const types = () => sent.map(m => m.type)
  const developer = () => pmJob({ runId: 'r1', role: 'developer', runtime: 'fake', planSessionId: null, taskId: 'task-1', taskRef: 'APP-1', branch: 'corral/app-1' })

  async function start(): Promise<RunManager> {
    const manager = new RunManager(config, connection, tools, new Map([['fake', runtime]]))
    manager.assign(developer())
    await expect.poll(() => up ? sent.some(m => m.type === 'run.started') : Boolean(line), { timeout: 10_000 }).toBe(true)
    return manager
  }

  beforeEach(async () => {
    vi.stubEnv('GIT_CONFIG_COUNT', '0')
    dataDir = await createTestDataDir()
    config = { dataDir, claudeBin: '/nonexistent/claude', codexBin: '/nonexistent/codex', name: 'test', serverUrl: new URL('http://127.0.0.1:9'), gitAuthor: null, pmWarmSeconds: 0, titleModel: 'haiku', slots: 4, roles: ['pm', 'developer', 'reviewer', 'design'] }
    sent = []
    up = true
    refreshes = 0
    line = undefined as unknown as typeof line
  })

  afterEach(async () => {
    vi.useRealTimers()
    vi.unstubAllEnvs()
    await rm(dirname(dataDir), { recursive: true, force: true })
  })

  it('replays a whole run in order after welcome, and only then forgets it', async () => {
    up = false
    const manager = await start()
    line({ events: [{ type: 'message', text: 'First' }] })
    await new Promise(resolve => setTimeout(resolve, 600))
    line({ events: [{ type: 'message', text: 'Last' }] })
    manager.stop('r1', 'timed_out', '60 s')
    await manager.shutdown()

    expect(sent).toEqual([])
    expect(manager.activeRuns()).toEqual([{ runId: 'r1', leaseEpoch: 1 }])
    expect(manager.activeRunCount()).toBe(1)

    reconnect(manager)

    expect(types()[0]).toBe('run.started')
    expect(types().at(-1)).toBe('run.ended')
    expect(sent.find(m => m.type === 'run.started')).toMatchObject({ agentSessionId: 'fake-session' })
    expect(sent.at(-1)).toMatchObject({ exit: { kind: 'timed_out', limitSeconds: 60 } })
    const said = sent.flatMap(m => m.type === 'run.events' ? m.events : []).flatMap(e => e.type === 'message' ? [e.text] : [])
    expect(said).toEqual(['First', 'Last'])
    expect(manager.activeRuns()).toEqual([])
    expect(manager.activeRunCount()).toBe(0)
  })

  it('keeps new traffic behind what is still waiting', async () => {
    const manager = await start()
    up = false
    line({ events: [{ type: 'message', text: 'While down' }] })
    await new Promise(resolve => setTimeout(resolve, 600))
    reconnect(manager)
    line({ events: [{ type: 'message', text: 'After' }] })
    await new Promise(resolve => setTimeout(resolve, 600))

    const said = sent.flatMap(m => m.type === 'run.events' ? m.events : []).flatMap(e => e.type === 'message' ? [e.text] : [])
    expect(said).toEqual(['While down', 'After'])
    manager.stop('r1', 'timed_out', '60 s')
    await manager.shutdown()
  })

  it('drops the oldest events past the cap, says so, and keeps the start, the end and the newest events', async () => {
    up = false
    const manager = await start()
    const big = 'x'.repeat(200_000)
    for (let i = 0; i < 100; i++) line({ events: [{ type: 'message', text: `${i}: ${big}` }] })
    line({ events: [{ type: 'message', text: 'The last word' }] })
    manager.stop('r1', 'timed_out', '60 s')
    await manager.shutdown()

    reconnect(manager)

    const events = sent.flatMap(m => m.type === 'run.events' ? m.events : [])
    const note = events.find((e): e is Extract<RunEvent, { type: 'system' }> => e.type === 'system' && e.text.includes('transcript events were dropped'))
    expect(note?.text).toMatch(/^\d+ transcript events were dropped here/)
    const dropped = Number(/^\d+/.exec(note!.text)![0])
    const messages = events.filter(e => e.type === 'message')
    expect(dropped).toBeGreaterThan(0)
    // Early system notes count as dropped events too
    expect(messages.length).toBeLessThan(101)
    expect(messages.length).toBeGreaterThanOrEqual(101 - dropped)
    expect(messages.at(-1)).toEqual({ type: 'message', text: 'The last word' })
    expect(types()[0]).toBe('run.started')
    expect(types().at(-1)).toBe('run.ended')
    expect(JSON.stringify(sent).length).toBeLessThan(18 * 1024 * 1024)
  })

  it('takes a stop from a server that gave up on the run before hearing it ended', async () => {
    up = false
    const manager = await start()
    manager.stop('r1', 'timed_out', '60 s')
    await manager.shutdown()

    up = true
    manager.handle({ type: 'run.stop', runId: 'r1', reason: 'The server no longer recognises this run' })
    manager.handle(WELCOME)

    expect(types().at(-1)).toBe('run.ended')
    expect(manager.activeRuns()).toEqual([])
  })

  it('fails open tool calls as soon as the socket drops', async () => {
    const manager = await start()
    const call = handler('get_task' as AgentTool, {})
    await expect.poll(() => types()).toContain('tool.call')

    manager.connectionLost()

    expect(await call).toEqual({ ok: false, error: 'Corral is unreachable right now. Wait a moment and try again.' })
    manager.stop('r1', 'timed_out', '60 s')
    await manager.shutdown()
  })

  it('waits on shutdown for a run that was already saving its work', async () => {
    // Reached once the run has ended and is pushing its WIP commit
    const pushing = join(dirname(dataDir), 'pushing')
    const hook = join(barePath(dataDir, TEST_REPOSITORY), 'hooks', 'pre-push')
    await writeFile(hook, `#!/bin/sh\ntouch '${pushing}'\nsleep 0.5\n`)
    await chmod(hook, 0o755)
    const manager = await start()
    manager.handle({ type: 'run.lease', runId: 'r1', leaseEpoch: 1, validUntil: new Date(Date.now() + 240_000).toISOString() })
    await writeFile(join(dataDir, 'worktrees', 'task-1', 'feature.txt'), 'half done\n')
    manager.handle({ type: 'run.stop', runId: 'r1', reason: 'Stopped by a human', keepWork: true })
    await expect.poll(() => stat(pushing).then(() => true, () => false), { timeout: 10_000 }).toBe(true)
    expect(types()).not.toContain('run.ended')

    await manager.shutdown()

    expect(sent.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'stopped' }, wipSha: expect.stringMatching(/^[0-9a-f]{40}$/) })
  })

  it('does not let a shutdown wait for the outcome grace', async () => {
    const manager = await start()
    const signals: NodeJS.Signals[] = []
    const report = handler('report_outcome' as AgentTool, { outcome: 'stuck', summary: 'Done' })
    await expect.poll(() => types()).toContain('tool.call')
    const call = sent.find(m => m.type === 'tool.call')
    manager.handle({ type: 'tool.result', callId: call?.type === 'tool.call' ? call.callId : '', ok: true, result: {} })
    await report
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })
    const kill = exit
    exit = (value) => {
      signals.push(value.signal!)
      kill(value)
    }

    manager.stop('r1', 'runner_shutdown', 'The runner is shutting down')
    await vi.advanceTimersByTimeAsync(0)

    expect(signals).toEqual(['SIGTERM'])
    vi.useRealTimers()
    await manager.shutdown()
  })

  it('joins a second report_outcome to the one under way', async () => {
    const manager = await start()
    const first = handler('report_outcome' as AgentTool, { outcome: 'stuck', summary: 'Done' })
    const second = handler('report_outcome' as AgentTool, { outcome: 'stuck', summary: 'Done again' })
    await expect.poll(() => types()).toContain('tool.call')
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(types().filter(t => t === 'tool.call')).toHaveLength(1)
    const call = sent.find(m => m.type === 'tool.call')
    manager.handle({ type: 'tool.result', callId: call?.type === 'tool.call' ? call.callId : '', ok: true, result: { recorded: true } })

    expect(await first).toEqual({ ok: true, result: { recorded: true } })
    expect(await second).toEqual({ ok: true, result: { recorded: true } })
    manager.stop('r1', 'timed_out', '60 s')
    await manager.shutdown()
  })

  it('saves no WIP over a report still pushing, and sends no report after run.ended', async () => {
    // Holds the push open until the test lets go of it
    const release = join(dirname(dataDir), 'release-push')
    const hook = join(barePath(dataDir, TEST_REPOSITORY), 'hooks', 'pre-push')
    await writeFile(hook, `#!/bin/sh\nwhile [ ! -f '${release}' ]; do sleep 0.02; done\n`)
    await chmod(hook, 0o755)
    const manager = await start()
    await writeFile(join(dataDir, 'worktrees', 'task-1', 'feature.txt'), 'half done\n')
    const report = handler('report_outcome' as AgentTool, { outcome: 'pr_opened', summary: 'Done' })
    await new Promise(resolve => setTimeout(resolve, 200))

    manager.stop('r1', 'timed_out', '60 s')
    await expect.poll(() => types(), { timeout: 10_000 }).toContain('run.ended')

    // Nothing was committed over the push: the file is still uncommitted
    const status = await git(['status', '--porcelain'], { cwd: join(dataDir, 'worktrees', 'task-1') })
    expect(status.stdout).toContain('feature.txt')
    await writeFile(release, '')
    expect(await report).toEqual({ ok: false, error: 'This run is over. Stop working.' })
    expect(types()).not.toContain('tool.call')
  })
})
