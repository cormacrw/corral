import type { AgentTool, RunEvent, RunnerMessage } from '@corral/contracts'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { AgentExit, AgentLauncher } from './agent-runtime.ts'
import { claudeCodeRuntime } from './claude.ts'
import type { RunnerConfig } from './config.ts'
import { exec } from './exec.ts'
import type { ToolHandler, ToolServer } from './mcp.ts'
import { barePath } from './layout.ts'
import { RunManager } from './run-manager.ts'
import { createRuntimes } from './runtimes.ts'
import { createTestDataDir, pmJob, TEST_REPOSITORY, testConfig, testConnection } from './test-repo.ts'

// Stands in for `claude` in stream-json input mode: logs how it was called
// and every stdin message, replays each message as it takes it in, and
// answers it with "Got: …". The "hold" turn stays open until the release file
// exists, like an agent busy with tool calls; a message that arrives then
// joins that turn, which ends with one result, as the CLI does. It exits once
// stdin closes and it has nothing left to answer. With the orphaned file, a
// --resume opens with the empty result the CLI prints for a background command
// the last process left behind, and its turn holds too.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, existsSync } = require('node:fs')
const { createInterface } = require('node:readline')
const log = line => appendFileSync(__filename + '.log', JSON.stringify(line) + '\\n')
const print = line => console.log(JSON.stringify(line))
log({ args: process.argv.slice(2) })
const orphaned = process.argv.includes('--resume') && existsSync(__filename + '.orphaned')
let busy = false
let closed = false
function take(content) {
  print({ type: 'user', isReplay: true, message: { role: 'user', content } })
  print({ type: 'assistant', message: { content: [{ type: 'text', text: 'Got: ' + content }] } })
}
function finish() {
  print({ type: 'result', subtype: 'success', is_error: false, result: 'Done', session_id: 'dev-session', usage: { input_tokens: 2, cache_creation_input_tokens: 5, cache_read_input_tokens: 7, output_tokens: 3 } })
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
    if (orphaned) print({ type: 'result', subtype: 'success', is_error: false, num_turns: 0, result: '', session_id: 'dev-session' })
    take(content)
    if (content !== 'hold' && !orphaned) return finish()
    const wait = setInterval(() => {
      if (!existsSync(__filename + '.release')) return
      clearInterval(wait)
      finish()
    }, 20)
  })
  .on('close', () => {
    log({ closed: true })
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
  const connection = testConnection((message: RunnerMessage) => sent.push(message) > 0)
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
    config = testConfig(dataDir, { claudeBin })
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
  const noted = (pattern: RegExp | string) => events().some(e => e.type === 'system' && (typeof pattern === 'string' ? e.text.includes(pattern) : pattern.test(e.text)))

  async function log(): Promise<{ args?: string[], stdin?: string, closed?: boolean }[]> {
    const text = await readFile(`${claudeBin}.log`, 'utf8').catch(() => '')
    return text.trim().split('\n').filter(Boolean).map(line => JSON.parse(line) as { args?: string[], stdin?: string, closed?: boolean })
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

  it.each(['developer', 'designer'] as const)('writes a message to a live %s run and shows its reply', async (role) => {
    const manager = new RunManager(config, connection, tools, createRuntimes(config).registry)
    manager.assign(devJob({ role }))
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

  it.each([['developer', 'stuck'], ['designer', 'stuck'], ['reviewer', 'approved']] as const)('ends a %s run normally once it reports its outcome', async (role, outcome) => {
    const sha = (await exec('git', ['rev-parse', 'main'], { cwd: barePath(dataDir, TEST_REPOSITORY) })).stdout.trim()
    const manager = new RunManager(config, connection, tools, createRuntimes(config).registry)
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
    const manager = new RunManager(config, connection, tools, createRuntimes(config).registry)
    manager.assign(devJob({ prompt: 'Build it' }))
    const messages = await finish('r1')

    expect(messages.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
    const calls = (await log()).flatMap(entry => entry.args ? [entry.args] : [])
    expect(calls).toHaveLength(2)
    expect(calls[1]).toEqual(expect.arrayContaining(['--resume', 'dev-session']))
    // The server stores the last total, so the second process adds to the first
    const usage = messages.flatMap(m => m.type === 'run.events' ? m.events.filter(e => e.type === 'usage') : [])
    expect(usage.at(-1)).toEqual({ type: 'usage', inputTokens: 4, cacheWriteTokens: 10, cacheReadTokens: 14, outputTokens: 6 })
  })

  describe('a retry resumed over a background command left behind', () => {
    // The retry has answered the empty result and is working on its real turn
    async function retrying(): Promise<RunManager> {
      await writeFile(`${claudeBin}.orphaned`, '')
      const manager = new RunManager(config, connection, tools, createRuntimes(config).registry)
      manager.assign(devJob({ prompt: 'Build it' }))
      await expect.poll(async () => (await stdin()).length, { timeout: 10_000 }).toBe(2)
      await expect.poll(() => noted(/resuming/i)).toBe(true)
      // The retry prints this after its empty result, so the runner has read that too
      await expect.poll(() => events().filter(e => e.type === 'message' && e.text.startsWith('Got: '))).toHaveLength(2)
      return manager
    }

    const closes = async () => (await log()).filter(entry => entry.closed).length

    it('keeps stdin open through the empty result, so the turn runs and its report completes the run', async () => {
      const manager = await retrying()
      // Only the first process's stdin has closed: nothing is counting down
      expect(await closes()).toBe(1)

      await reportOutcome(manager, 'stuck')
      await release()
      const messages = await finish('r1')

      expect(noted(/resumed agent reported/i)).toBe(true)
      expect(messages.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
      expect(manager.activeRuns()).toEqual([])
    })

    it('says so when the retry finishes its real turn and still reports nothing', async () => {
      await retrying()
      await release()
      const messages = await finish('r1')

      expect(noted(/resumed agent exited/i)).toBe(true)
      expect(messages.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
    })
  })

  it('ignores a message whose lease epoch is stale', async () => {
    const manager = new RunManager(config, connection, tools, createRuntimes(config).registry)
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
    const codex: AgentLauncher = {
      id: 'codex',
      spawn: (options) => {
        options.onLine('{}', { events: [], sessionId: 'codex-session', rateLimit: null, result: null })
        return { pid: -1, exited: new Promise(resolve => (exit = resolve)), kill: () => exit({ code: null, signal: 'SIGTERM' }) }
      }
    }
    const manager = new RunManager(config, connection, tools, new Map([['claude-code', claudeCodeRuntime({ bin: claudeBin, configDir: config.claudeConfigDir })], ['codex', codex]]))
    manager.assign(devJob({ runtime: 'codex' }))
    await started('r1')

    manager.handle({ type: 'run.message', runId: 'r1', leaseEpoch: 3, text: 'Use pnpm' })

    const rejected = sent.find(m => m.type === 'run.message.rejected')
    expect(rejected).toEqual({ type: 'run.message.rejected', runId: 'r1', leaseEpoch: 3, text: 'Use pnpm', error: expect.any(String) })
    await reportOutcome(manager, 'stuck')
    exit({ code: 0, signal: null })
    await finish('r1')
    // The transcript says why it never arrived
    expect(noted(rejected?.type === 'run.message.rejected' ? rejected.error : '')).toBe(true)
    expect(events().some(e => e.type === 'message' && e.text === 'Use pnpm')).toBe(false)
  })

  it('rejects a message for a run that has ended', async () => {
    const manager = new RunManager(config, connection, tools, createRuntimes(config).registry)
    manager.assign(devJob())
    await started('r1')
    await reportOutcome(manager, 'stuck')

    // Reported but still finishing its turn: the run is over for messages
    manager.handle({ type: 'run.message', runId: 'r1', leaseEpoch: 3, text: 'Too late' })
    await release()
    await finish('r1')
    manager.handle({ type: 'run.message', runId: 'r1', leaseEpoch: 3, text: 'Much too late' })

    expect(sent.filter(m => m.type === 'run.message.rejected')).toEqual([
      { type: 'run.message.rejected', runId: 'r1', leaseEpoch: 3, text: 'Too late', error: expect.stringMatching(/reported/) },
      { type: 'run.message.rejected', runId: 'r1', leaseEpoch: 3, text: 'Much too late', error: expect.stringMatching(/ended/) }
    ])
    expect(await stdin()).toEqual(['hold'])
  })

  it('rejects a message for a PM run', async () => {
    const manager = new RunManager(config, connection, tools, createRuntimes(config).registry)
    manager.assign(pmJob({ runId: 'pm' }))
    manager.handle({ type: 'run.message', runId: 'pm', leaseEpoch: 1, text: 'Hi' })

    expect(sent).toContainEqual({ type: 'run.message.rejected', runId: 'pm', leaseEpoch: 1, text: 'Hi', error: expect.any(String) })
    await finish('pm')
  })
})
