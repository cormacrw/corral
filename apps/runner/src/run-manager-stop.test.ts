import type { AgentTool, RunnerMessage } from '@corral/contracts'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { STOP_GRACE_MS, type AgentExit, type AgentRuntime } from './agent-runtime.ts'
import type { RunnerConfig } from './config.ts'
import type { ServerConnection } from './connection.ts'
import type { ToolHandler, ToolServer } from './mcp.ts'
import { RunManager } from './run-manager.ts'
import { createTestDataDir, pmJob } from './test-repo.ts'

const OUTCOME_EXIT_GRACE_MS = 20_000

describe('RunManager stopping a run', () => {
  let dataDir: string
  let config: RunnerConfig
  let sent: RunnerMessage[]
  let handlers: ToolHandler[]
  // The signals the agent process got, in order
  let signals: NodeJS.Signals[]
  const connection = { send: (message: RunnerMessage) => sent.push(message) > 0 } as unknown as ServerConnection
  const tools = {
    register: (_secret: string, _role: string, handler: ToolHandler) => {
      handlers.push(handler)
      return () => {}
    },
    url: () => 'http://127.0.0.1:9/mcp'
  } as unknown as ToolServer

  // An agent that runs until it is signalled
  const runtime: AgentRuntime = {
    id: 'fake',
    spawn: (options) => {
      let exit!: (value: AgentExit) => void
      options.onLine('{}', { events: [], sessionId: 'fake-session', rateLimit: null, result: null })
      return {
        pid: -1,
        exited: new Promise(resolve => (exit = resolve)),
        kill: (signal) => {
          signals.push(signal)
          exit({ code: null, signal })
        }
      }
    }
  }

  beforeEach(async () => {
    dataDir = await createTestDataDir()
    config = { dataDir, claudeBin: '/nonexistent/claude', codexBin: '/nonexistent/codex', name: 'test', serverUrl: new URL('http://127.0.0.1:9'), gitAuthor: null, pmWarmSeconds: 0 }
    sent = []
    handlers = []
    signals = []
  })

  afterEach(async () => {
    vi.useRealTimers()
    await rm(dirname(dataDir), { recursive: true, force: true })
  })

  async function startRun(): Promise<RunManager> {
    const manager = new RunManager(config, connection, tools, new Map([['fake', runtime]]))
    manager.assign(pmJob({ runId: 'r1', role: 'developer', runtime: 'fake', planSessionId: null, taskId: 'task-1', taskRef: 'APP-1', branch: 'corral/app-1' }))
    await expect.poll(() => sent.some(m => m.type === 'run.started'), { timeout: 10_000 }).toBe(true)
    return manager
  }

  // The agent calls report_outcome; the server hasn't answered yet
  async function callReportOutcome(): Promise<{ result: Promise<unknown>, callId: string }> {
    const result = handlers.at(-1)!('report_outcome' as AgentTool, { outcome: 'stuck', summary: 'Done' })
    await expect.poll(() => sent.find(m => m.type === 'tool.call')).toBeTruthy()
    const call = sent.find(m => m.type === 'tool.call')!
    return { result, callId: call.type === 'tool.call' ? call.callId : '' }
  }

  it('answers report_outcome and waits the grace period when the stop arrives before the result', async () => {
    const manager = await startRun()
    const call = await callReportOutcome()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    // The server stops the run as it accepts the outcome, then answers the call
    manager.handle({ type: 'run.stop', runId: 'r1', reason: 'The agent reported stuck' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(signals).toEqual([])
    manager.handle({ type: 'tool.result', callId: call.callId, ok: true, result: { recorded: true } })

    expect(await call.result).toEqual({ ok: true, result: { recorded: true } })
    await vi.advanceTimersByTimeAsync(OUTCOME_EXIT_GRACE_MS - 1)
    expect(signals).toEqual([])
    await vi.advanceTimersByTimeAsync(1)
    expect(signals).toEqual(['SIGTERM'])
  })

  it('signals right after the result when the server rejects the outcome', async () => {
    const manager = await startRun()
    const call = await callReportOutcome()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    manager.handle({ type: 'run.stop', runId: 'r1', reason: 'Stopped by a human' })
    await vi.advanceTimersByTimeAsync(1_000)
    expect(signals).toEqual([])
    manager.handle({ type: 'tool.result', callId: call.callId, ok: false, error: 'Attach evidence first' })

    expect(await call.result).toEqual({ ok: false, error: 'Attach evidence first' })
    await vi.advanceTimersByTimeAsync(0)
    expect(signals).toEqual(['SIGTERM'])
  })

  it('signals at once on a stop with no outcome in flight', async () => {
    const manager = await startRun()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    manager.handle({ type: 'run.stop', runId: 'r1', reason: 'Stopped by a human' })
    await vi.advanceTimersByTimeAsync(0)
    expect(signals).toEqual(['SIGTERM'])
  })

  it('signals at once on the time limit, even with report_outcome in flight', async () => {
    const manager = await startRun()
    await callReportOutcome()
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] })

    manager.stop('r1', 'timed_out', '60 s')
    await vi.advanceTimersByTimeAsync(0)
    expect(signals).toEqual(['SIGTERM'])
    // Only one signal: the process exited, so the SIGKILL timer was cleared
    await vi.advanceTimersByTimeAsync(STOP_GRACE_MS)
    expect(signals).toEqual(['SIGTERM'])
  })
})
