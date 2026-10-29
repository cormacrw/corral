import type { AgentTool, RunEvent, RunnerMessage } from '@corral/contracts'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentExit, AgentRuntime } from './agent-runtime.ts'
import { claudeCodeRuntime } from './agent.ts'
import type { RunnerConfig } from './config.ts'
import type { ServerConnection } from './connection.ts'
import { exec } from './exec.ts'
import type { ToolHandler, ToolServer } from './mcp.ts'
import { barePath } from './repos.ts'
import { RunManager } from './run-manager.ts'
import { createTestDataDir, pmJob, TEST_REPOSITORY } from './test-repo.ts'

// Stands in for `claude` in stream-json input mode: logs how it was called
// and every stdin message, replays each message as it takes it in, and
// answers it with "Got: …". The "hold" turn stays open until the release file
// exists, like an agent busy with tool calls; a message that arrives then
// joins that turn, which ends with one result, as the CLI does. It exits once
// stdin closes and it has nothing left to answer.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, existsSync } = require('node:fs')
const { createInterface } = require('node:readline')
const log = line => appendFileSync(__filename + '.log', JSON.stringify(line) + '\\n')
const print = line => console.log(JSON.stringify(line))
log({ args: process.argv.slice(2) })
let busy = false
let closed = false
function take(content) {
  print({ type: 'user', isReplay: true, message: { role: 'user', content } })
  print({ type: 'assistant', message: { content: [{ type: 'text', text: 'Got: ' + content }] } })
}
function finish() {
  print({ type: 'result', subtype: 'success', is_error: false, result: 'Done', session_id: 'dev-session' })
  busy = false
  if (closed) process.exit(0)
}
createInterface({ input: process.stdin })
  .on('line', line => {
    const content = JSON.parse(line).message.content
    log({ stdin: content })
    if (busy) return take(content)
    busy = true
    print({ type: 'system', subtype: 'init', session_id: 'dev-session' })
    take(content)
    if (content !== 'hold') return finish()
    const wait = setInterval(() => {
      if (!existsSync(__filename + '.release')) return
      clearInterval(wait)
      finish()
    }, 20)
  })
  .on('close', () => {
    closed = true
    if (!busy) process.exit(0)
  })
`

describe('RunManager messages for live runs', () => {
  let dataDir: string
  let claudeBin: string
  let config: RunnerConfig
  let sent: RunnerMessage[]
  let handlers: ToolHandler[]
  const connection = { send: (message: RunnerMessage) => sent.push(message) > 0 } as unknown as ServerConnection
  const tools = {
    register: (_secret: string, _role: string, handler: ToolHandler) => {
      handlers.push(handler)
      return () => {}
    },
    url: () => 'http://127.0.0.1:9/mcp'
  } as unknown as ToolServer

  beforeEach(async () => {
    dataDir = await createTestDataDir()
    claudeBin = join(dirname(dataDir), 'claude')
    await writeFile(claudeBin, FAKE_CLAUDE)
    await chmod(claudeBin, 0o755)
    config = { dataDir, claudeBin, codexBin: '/nonexistent/codex', name: 'test', serverUrl: new URL('http://127.0.0.1:9'), gitAuthor: null, pmWarmSeconds: 0, titleModel: 'haiku' }
    sent = []
    handlers = []
  })

  afterEach(async () => {
    await rm(dirname(dataDir), { recursive: true, force: true })
  })

  function devJob(overrides: Parameters<typeof pmJob>[0] = {}) {
    return pmJob({ runId: 'r1', role: 'developer', leaseEpoch: 3, planSessionId: null, taskId: 'task-1', taskRef: 'APP-1', branch: 'corral/app-1', prompt: 'hold', ...overrides })
  }

  async function started(runId: string) {
    await expect.poll(() => sent.some(m => m.type === 'run.started' && m.runId === runId), { timeout: 10_000 }).toBe(true)
  }

  async function finish(runId: string) {
    await expect.poll(() => sent.find(m => m.type === 'run.ended' && m.runId === runId), { timeout: 10_000 }).toBeTruthy()
    return sent.filter(m => 'runId' in m && m.runId === runId)
  }

  function events(): RunEvent[] {
    return sent.flatMap(m => m.type === 'run.events' ? m.events : [])
  }

  async function log(): Promise<{ args?: string[], stdin?: string }[]> {
    const text = await readFile(`${claudeBin}.log`, 'utf8').catch(() => '')
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { args?: string[], stdin?: string })
  }

  async function stdin(): Promise<string[]> {
    return (await log()).flatMap(entry => entry.stdin === undefined ? [] : [entry.stdin])
  }

  // The agent calls report_outcome and the server accepts it
  async function reportOutcome(manager: RunManager, outcome: string): Promise<void> {
    const call = handlers.at(-1)!('report_outcome' as AgentTool, { outcome, summary: 'Done' })
    await expect.poll(() => sent.find(m => m.type === 'tool.call')).toBeTruthy()
    const toolCall = sent.find(m => m.type === 'tool.call')!
    manager.handle({ type: 'tool.result', callId: toolCall.type === 'tool.call' ? toolCall.callId : '', ok: true, result: {} })
    expect(await call).toEqual({ ok: true, result: {} })
  }

  async function release(): Promise<void> {
    await writeFile(`${claudeBin}.release`, '')
  }

  it('writes a message to a live developer run\'s stdin and shows it in the transcript', async () => {
    const manager = new RunManager(config, connection, tools)
    manager.assign(devJob())
    await started('r1')

    manager.handle({ type: 'run.message', runId: 'r1', leaseEpoch: 3, text: 'Use pnpm, not npm' })

    expect(events()).toContainEqual({ type: 'message', text: 'Use pnpm, not npm' })
    await expect.poll(stdin).toEqual(['hold', 'Use pnpm, not npm'])
    await reportOutcome(manager, 'stuck')
    await release()
    await finish('r1')
    // The agent took it into the turn under way and answered it
    expect(events()).toContainEqual({ type: 'message', text: 'Got: Use pnpm, not npm' })
    expect(sent.some(m => m.type === 'run.message.rejected')).toBe(false)
  })

  it.each([['developer', 'stuck'], ['reviewer', 'approved']] as const)('ends a %s run normally once it reports its outcome', async (role, outcome) => {
    const sha = (await exec('git', ['rev-parse', 'main'], { cwd: barePath(dataDir, TEST_REPOSITORY) })).stdout.trim()
    const manager = new RunManager(config, connection, tools)
    manager.assign(devJob({ role, headSha: role === 'reviewer' ? sha : null }))
    await started('r1')
    await reportOutcome(manager, outcome)
    await release()
    const messages = await finish('r1')

    expect(messages.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
    expect(manager.activeRuns()).toEqual([])
    // One process, started to read its input from stdin, and no resume to report
    const calls = (await log()).flatMap(entry => entry.args ? [entry.args] : [])
    expect(calls).toHaveLength(1)
    expect(calls[0]).toEqual(expect.arrayContaining(['--input-format', 'stream-json']))
    expect(calls[0]).not.toContain('-p')
  })

  it('still resumes once to report when the agent finishes without an outcome', async () => {
    const manager = new RunManager(config, connection, tools)
    manager.assign(devJob({ prompt: 'Build it' }))
    const messages = await finish('r1')

    expect(messages.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
    const calls = (await log()).flatMap(entry => entry.args ? [entry.args] : [])
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(expect.arrayContaining(['--resume', 'dev-session']))
  })

  it('ignores a message whose lease epoch is stale', async () => {
    const manager = new RunManager(config, connection, tools)
    manager.assign(devJob())
    await started('r1')

    manager.handle({ type: 'run.message', runId: 'r1', leaseEpoch: 2, text: 'From an old lease' })
    await reportOutcome(manager, 'stuck')
    await release()
    await finish('r1')

    expect(await stdin()).toEqual(['hold'])
    expect(JSON.stringify(events())).not.toContain('From an old lease')
    expect(sent.some(m => m.type === 'run.message.rejected')).toBe(false)
  })

  it('rejects a message for a Codex run, which can\'t take input mid-run', async () => {
    let exit!: (value: AgentExit) => void
    const codex: AgentRuntime = {
      id: 'codex',
      spawn: (options) => {
        options.onLine('{}', { events: [], sessionId: 'codex-session', rateLimit: null, result: null })
        return { pid: -1, exited: new Promise(resolve => (exit = resolve)), kill: () => exit({ code: null, signal: 'SIGTERM' }) }
      }
    }
    const manager = new RunManager(config, connection, tools, new Map([['claude-code', claudeCodeRuntime(claudeBin)], ['codex', codex]]))
    manager.assign(devJob({ runtime: 'codex' }))
    await started('r1')

    manager.handle({ type: 'run.message', runId: 'r1', leaseEpoch: 3, text: 'Use pnpm' })

    expect(sent).toContainEqual({ type: 'run.message.rejected', runId: 'r1', leaseEpoch: 3, text: 'Use pnpm', error: 'A codex run can\'t take input while it runs' })
    await reportOutcome(manager, 'stuck')
    exit({ code: 0, signal: null })
    await finish('r1')
    expect(events()).toContainEqual({ type: 'system', text: 'A message was not delivered: A codex run can\'t take input while it runs' })
    expect(events().some(e => e.type === 'message' && e.text === 'Use pnpm')).toBe(false)
  })

  it('rejects a message for a run that has ended', async () => {
    const manager = new RunManager(config, connection, tools)
    manager.assign(devJob())
    await started('r1')
    await reportOutcome(manager, 'stuck')

    // Reported but still finishing its turn: the run is over for messages
    manager.handle({ type: 'run.message', runId: 'r1', leaseEpoch: 3, text: 'Too late' })
    await release()
    await finish('r1')
    manager.handle({ type: 'run.message', runId: 'r1', leaseEpoch: 3, text: 'Much too late' })

    expect(sent.filter(m => m.type === 'run.message.rejected')).toEqual([
      { type: 'run.message.rejected', runId: 'r1', leaseEpoch: 3, text: 'Too late', error: 'The agent has already reported its outcome' },
      { type: 'run.message.rejected', runId: 'r1', leaseEpoch: 3, text: 'Much too late', error: 'The run has ended' }
    ])
    expect(await stdin()).toEqual(['hold'])
  })

  it('rejects a message for a PM run', async () => {
    const manager = new RunManager(config, connection, tools)
    manager.assign(pmJob({ runId: 'pm' }))
    manager.handle({ type: 'run.message', runId: 'pm', leaseEpoch: 1, text: 'Hi' })

    expect(sent).toContainEqual({ type: 'run.message.rejected', runId: 'pm', leaseEpoch: 1, text: 'Hi', error: 'A pm run doesn\'t take messages' })
    await finish('pm')
  })
})
