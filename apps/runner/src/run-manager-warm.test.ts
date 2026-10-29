import type { RunnerMessage } from '@corral/contracts'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerConnection } from './connection.ts'
import { exec } from './exec.ts'
import type { ToolServer } from './mcp.ts'
import { RunManager } from './run-manager.ts'
import { createTestDataDir, pmJob } from './test-repo.ts'
import { pmWorktreePath } from './workspace.ts'

// Stands in for `claude`. With -p it answers once and exits; with
// --input-format stream-json it stays alive and answers each stdin message,
// repeating the init line every turn. A --resume of any session but
// "fresh-session" fails at startup. Each process starts a `sleep` helper in
// its group, like a dev server an agent leaves running, and logs both pids.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const { spawn } = require('node:child_process')
const { createInterface } = require('node:readline')
const args = process.argv.slice(2)
const helper = spawn('sleep', ['600'], { stdio: 'ignore' })
appendFileSync(__filename + '.log', JSON.stringify({ args, cwd: process.cwd(), pid: process.pid, helperPid: helper.pid }) + '\\n')
const resume = args.includes('--resume') ? args[args.indexOf('--resume') + 1] : null
if (resume && resume !== 'fresh-session') {
  console.error('No conversation found with session ID: ' + resume)
  helper.kill()
  process.exit(1)
}
function answer(content) {
  console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fresh-session' }))
  if (content === 'hang') return
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Answered ' + content + ' in ' + process.pid }] } }))
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done', session_id: 'fresh-session' }))
}
if (args.includes('-p')) {
  answer(args[args.indexOf('-p') + 1])
  helper.kill()
} else {
  createInterface({ input: process.stdin }).on('line', line => answer(JSON.parse(line).message.content))
}
`

interface Call { args: string[], cwd: string, pid: number, helperPid: number }

// A zombie isn't running: in a container nobody may reap it straight away
async function running(pid: number): Promise<boolean> {
  const stat = await readFile(`/proc/${pid}/stat`, 'utf8').catch(() => null)
  if (stat !== null) return !/^\d+ \(.*\) Z/.test(stat)
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('RunManager warm PM sessions', () => {
  let dataDir: string
  let claudeBin: string
  let sent: RunnerMessage[]
  let manager: RunManager

  function createManager(pmWarmSeconds: number): RunManager {
    const connection = { send: (message: RunnerMessage) => sent.push(message) > 0 } as unknown as ServerConnection
    const tools = { register: () => () => {}, url: () => 'http://127.0.0.1:9/mcp' } as unknown as ToolServer
    return new RunManager({ dataDir, claudeBin, codexBin: 'codex', name: 'test', serverUrl: new URL('http://127.0.0.1:9'), gitAuthor: null, pmWarmSeconds }, connection, tools)
  }

  beforeEach(async () => {
    dataDir = await createTestDataDir()
    claudeBin = join(dirname(dataDir), 'claude')
    await writeFile(claudeBin, FAKE_CLAUDE)
    await chmod(claudeBin, 0o755)
    sent = []
    manager = createManager(300)
  })

  afterEach(async () => {
    await manager.shutdown()
    for (const call of await calls().catch(() => [])) {
      for (const pid of [call.pid, call.helperPid]) {
        if (await running(pid)) process.kill(pid, 'SIGKILL')
      }
    }
    await rm(dirname(dataDir), { recursive: true, force: true })
  })

  async function finish(runId: string) {
    await expect.poll(() => sent.find(m => m.type === 'run.ended' && m.runId === runId), { timeout: 10_000 }).toBeTruthy()
    return sent.filter(m => 'runId' in m && m.runId === runId)
  }

  async function calls(): Promise<Call[]> {
    const log = await readFile(`${claudeBin}.log`, 'utf8')
    return log.trim().split('\n').map(line => JSON.parse(line) as Call)
  }

  async function processesLeft(): Promise<number[]> {
    const pids = (await calls()).flatMap(call => [call.pid, call.helperPid])
    const alive = await Promise.all(pids.map(async pid => (await running(pid)) ? pid : null))
    return alive.filter(pid => pid !== null)
  }

  function events(messages: RunnerMessage[]) {
    return messages.flatMap(m => m.type === 'run.events' ? m.events : [])
  }

  function replies(messages: RunnerMessage[]): string[] {
    return events(messages).flatMap(e => e.type === 'message' ? [e.text] : [])
  }

  function notes(messages: RunnerMessage[]): string[] {
    return events(messages).flatMap(e => e.type === 'system' ? [e.text] : [])
  }

  // A first turn that leaves its process warm
  async function firstTurn(overrides: Parameters<typeof pmJob>[0] = {}): Promise<Call> {
    manager.assign(pmJob({ runId: 'r1', planSessionId: 's1', prompt: 'first', ...overrides }))
    await finish('r1')
    const [call] = await calls()
    expect(await running(call!.pid)).toBe(true)
    return call!
  }

  const followUp = (overrides: Parameters<typeof pmJob>[0] = {}) =>
    pmJob({ runId: 'r2', planSessionId: 's1', agentSessionId: 'fresh-session', fallbackPrompt: 'Summary', prompt: 'second', ...overrides })

  it('answers a second message with the same process, each turn still its own run', async () => {
    const first = await firstTurn()
    // New code lands on the default branch between turns
    const origin = join(dirname(dataDir), 'origin')
    await writeFile(join(origin, 'NEW.md'), 'Fresh\n')
    const git = (args: string[]) => exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: origin })
    await git(['add', 'NEW.md'])
    await git(['commit', '--quiet', '-m', 'New file'])

    manager.assign(followUp())
    const second = await finish('r2')

    expect(await calls()).toHaveLength(1)
    expect(first.args).toEqual(expect.arrayContaining(['--input-format', 'stream-json']))
    expect(first.args).not.toContain('-p')
    expect(replies(sent.filter(m => 'runId' in m && m.runId === 'r1'))).toEqual([`Answered first in ${first.pid}`])
    expect(replies(second)).toEqual([`Answered second in ${first.pid}`])
    for (const runId of ['r1', 'r2']) {
      const messages = sent.filter(m => 'runId' in m && m.runId === runId)
      expect(messages.filter(m => m.type === 'run.started')).toHaveLength(1)
      expect(messages.filter(m => m.type === 'run.ended')).toHaveLength(1)
    }
    expect(second.find(m => m.type === 'run.started')).toMatchObject({ agentSessionId: 'fresh-session', leaseEpoch: 1 })
    expect(second.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
    // A follow-up turn is quiet, and the checkout was reset to fresh code
    expect(notes(second)).toEqual([])
    expect(await readFile(join(pmWorktreePath(dataDir, 'project-1', 's1'), 'NEW.md'), 'utf8')).toBe('Fresh\n')
    expect(await running(first.pid)).toBe(true)
  })

  it('kills the process group after the idle timeout, and the next message cold-starts with --resume', async () => {
    manager = createManager(0.5)
    const first = await firstTurn()
    await expect.poll(processesLeft, { timeout: 5_000 }).toEqual([])

    manager.assign(followUp())
    const second = await finish('r2')

    const log = await calls()
    expect(log).toHaveLength(2)
    expect(log[1]!.pid).not.toBe(first.pid)
    expect(log[1]!.args).toEqual(expect.arrayContaining(['--resume', 'fresh-session', '--input-format', 'stream-json']))
    expect(second.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
    expect(replies(second)).toEqual([`Answered second in ${log[1]!.pid}`])
  })

  it('cold-starts when the model changes', async () => {
    const first = await firstTurn()
    manager.assign(followUp({ model: 'opus' }))
    const second = await finish('r2')

    const log = await calls()
    expect(log).toHaveLength(2)
    expect(log[1]!.args).toEqual(expect.arrayContaining(['--resume', 'fresh-session', '--model', 'opus']))
    expect(second.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
    expect(await running(first.pid)).toBe(false)
    expect(await running(first.helperPid)).toBe(false)
  })

  it('cold-starts when the job names another agent session', async () => {
    const first = await firstTurn()
    manager.assign(followUp({ agentSessionId: 'another-session' }))
    const second = await finish('r2')

    const log = await calls()
    // The resume of the unknown session fails, then the fallback starts fresh
    expect(log).toHaveLength(3)
    expect(log[1]!.args).toEqual(expect.arrayContaining(['--resume', 'another-session']))
    expect(log[2]!.args).not.toContain('--resume')
    expect(second.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
    expect(await running(first.pid)).toBe(false)
  })

  it('cold-starts when the warm process died', async () => {
    const first = await firstTurn()
    process.kill(-first.pid, 'SIGKILL')
    await expect.poll(() => running(first.pid)).toBe(false)
    manager.assign(followUp())
    const second = await finish('r2')

    const log = await calls()
    expect(log).toHaveLength(2)
    expect(log[1]!.args).toEqual(expect.arrayContaining(['--resume', 'fresh-session']))
    expect(second.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
    expect(replies(second)).toEqual([`Answered second in ${log[1]!.pid}`])
  })

  it('kills the warm process when a turn is stopped', async () => {
    await firstTurn()
    manager.assign(followUp({ prompt: 'hang' }))
    await expect.poll(() => sent.some(m => m.type === 'run.started' && m.runId === 'r2')).toBe(true)
    manager.stop('r2', 'stopped', 'The user stopped it')
    const second = await finish('r2')

    expect(second.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'stopped' } })
    await expect.poll(processesLeft).toEqual([])
  })

  it('kills the warm process when a turn hits its time limit', async () => {
    await firstTurn()
    manager.assign(followUp({ prompt: 'hang', timeoutSeconds: 1 }))
    const second = await finish('r2')

    expect(second.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'timed_out' } })
    await expect.poll(processesLeft).toEqual([])
  })

  it('kills a cold-started turn that hits its time limit', async () => {
    manager.assign(pmJob({ runId: 'r1', planSessionId: 's1', prompt: 'hang', timeoutSeconds: 1 }))
    const first = await finish('r1')

    expect(first.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'timed_out' } })
    await expect.poll(processesLeft).toEqual([])
  })

  it('kills every warm process on runner shutdown', async () => {
    await firstTurn()
    manager.assign(pmJob({ runId: 'other', planSessionId: 's2', prompt: 'other session' }))
    await finish('other')
    manager.assign(pmJob({ runId: 'busy', planSessionId: 's3', prompt: 'hang' }))
    await expect.poll(() => sent.some(m => m.type === 'run.started' && m.runId === 'busy')).toBe(true)
    expect(await processesLeft()).toHaveLength(6)

    await manager.shutdown()

    expect(await processesLeft()).toEqual([])
    expect(sent.find(m => m.type === 'run.ended' && m.runId === 'busy')).toMatchObject({ exit: { kind: 'stopped' } })
  })

  it('reports no active run while warm, so a developer run can take the only slot', async () => {
    const first = await firstTurn()
    expect(manager.activeRuns()).toEqual([])

    manager.assign(pmJob({ runId: 'dev', role: 'developer', planSessionId: null, taskId: 'task-1', taskRef: 'APP-1', branch: 'corral/app-1' }))
    const dev = await finish('dev')

    expect(dev.find(m => m.type === 'run.started')).toBeTruthy()
    expect(dev.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
    expect(await running(first.pid)).toBe(true)
  })

  it('starts a process per turn and keeps none when pmWarmSeconds is 0', async () => {
    manager = createManager(0)
    manager.assign(pmJob({ runId: 'r1', planSessionId: 's1', prompt: 'first' }))
    await finish('r1')
    await expect.poll(processesLeft).toEqual([])
    manager.assign(followUp())
    await finish('r2')

    const log = await calls()
    expect(log).toHaveLength(2)
    expect(log[0]!.args).toEqual(expect.arrayContaining(['-p', 'first']))
    expect(log[1]!.args).toEqual(expect.arrayContaining(['-p', 'second', '--resume', 'fresh-session']))
    await expect.poll(processesLeft).toEqual([])
    // Scratch output stays per run, as before
    expect(log[1]!.args.join(' ')).toContain(join(dataDir, 'scratch', 'r2'))
  })
})
