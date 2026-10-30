import type { RunnerMessage } from '@corral/contracts'
import { chmod, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { createRuntimeRegistry, type AgentRuntime, type RuntimeOptions } from './agent-runtime.ts'
import type { RunnerConfig } from './config.ts'
import type { ServerConnection } from './connection.ts'
import type { ToolServer } from './mcp.ts'
import { RunManager } from './run-manager.ts'
import { createTestDataDir, pmJob } from './test-repo.ts'

// A runtime that answers at once without starting a process
function fakeRuntime(id: string, calls: RuntimeOptions[]): AgentRuntime {
  return {
    id,
    spawn(options) {
      calls.push(options)
      options.onLine('{}', { events: [{ type: 'message', text: `Hello from ${id}` }], sessionId: 'fake-session', rateLimit: null, result: { isError: false, text: 'Done' } })
      return { pid: -1, exited: Promise.resolve({ code: 0, signal: null }), kill: () => {} }
    }
  }
}

describe('RunManager runtimes', () => {
  let dataDir: string
  let config: RunnerConfig
  let sent: RunnerMessage[]
  const connection = { send: (message: RunnerMessage) => sent.push(message) > 0 } as unknown as ServerConnection
  const tools = { register: () => () => {}, url: () => 'http://127.0.0.1:9/mcp' } as unknown as ToolServer

  beforeEach(async () => {
    dataDir = await createTestDataDir()
    // A binary that doesn't exist: nothing here may start `claude`
    config = { dataDir, claudeBin: '/nonexistent/claude', codexBin: '/nonexistent/codex', name: 'test', serverUrl: new URL('http://127.0.0.1:9'), gitAuthor: null, pmWarmSeconds: 300, titleModel: 'haiku', slots: 4, roles: ['pm', 'developer', 'reviewer', 'design'] }
    sent = []
  })

  afterEach(async () => {
    await rm(dirname(dataDir), { recursive: true, force: true })
  })

  async function finish(runId: string) {
    await expect.poll(() => sent.find(m => m.type === 'run.ended' && m.runId === runId), { timeout: 10_000 }).toBeTruthy()
    return sent.filter(m => 'runId' in m && m.runId === runId)
  }

  it('registers Claude Code as claude-code and Codex as codex', () => {
    const registry = createRuntimeRegistry(config)
    expect([...registry.keys()]).toEqual(['claude-code', 'codex'])
    expect(registry.get('claude-code')?.spawnSession).toBeTypeOf('function')
    // No streaming session: a Codex PM turn is a one-shot resume
    expect(registry.get('codex')?.spawnSession).toBeUndefined()
  })

  it('ends a Codex run that hits its usage limit as rate_limited with the reset time', async () => {
    const fixture = join(import.meta.dirname, 'fixtures', 'codex', 'usage-limit.jsonl')
    const codexBin = join(dirname(dataDir), 'codex')
    // Stands in for `codex`: logs its arguments and prints the fixture
    await writeFile(codexBin, `#!/bin/sh\nprintf '%s\\n' "$@" > "$0.args"\ncat ${JSON.stringify(fixture)}\nexit 1\n`)
    await chmod(codexBin, 0o755)
    const manager = new RunManager({ ...config, codexBin }, connection, tools)
    manager.assign(pmJob({ runId: 'r1', runtime: 'codex', prompt: 'Plan it', model: 'gpt-5.5-codex' }))
    const messages = await finish('r1')

    expect(messages.find(m => m.type === 'run.started')).toMatchObject({ agentSessionId: '01a185f0-2c11-7a40-9d1e-3f4b5c6d7e8f' })
    expect(messages.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'rate_limited', resetsAt: new Date(2026, 9, 30, 15, 5).toISOString() } })
    const args = (await readFile(`${codexBin}.args`, 'utf8')).trim().split('\n')
    expect(args.slice(0, 2)).toEqual(['exec', '--json'])
    expect(args).toContain('mcp_servers.corral.url="http://127.0.0.1:9/mcp"')
    expect(args.slice(-2)).toEqual(['--', 'Plan it'])
  })

  it('ends a job with an unknown runtime with an error that names it', async () => {
    const manager = new RunManager(config, connection, tools)
    manager.assign(pmJob({ runId: 'r1', runtime: 'nope' }))
    const ended = (await finish('r1')).find(m => m.type === 'run.ended')

    expect(ended).toMatchObject({ type: 'run.ended', exit: { kind: 'error' } })
    const exit = ended!.type === 'run.ended' ? ended!.exit : null
    expect(exit?.kind === 'error' && exit.message).toContain('"nope"')
    expect(manager.activeRuns()).toEqual([])
  })

  it('starts the agent through the adapter the job names', async () => {
    const calls: RuntimeOptions[] = []
    const manager = new RunManager(config, connection, tools, new Map([['fake', fakeRuntime('fake', calls)]]))
    // The fake has no streaming session, so this PM turn runs one-shot even with warm sessions on
    manager.assign(pmJob({ runId: 'r1', runtime: 'fake', prompt: 'Plan it' }))
    const messages = await finish('r1')

    expect(calls).toHaveLength(1)
    expect(calls[0]).toMatchObject({ prompt: 'Plan it', model: null, resumeSessionId: null })
    expect(messages.find(m => m.type === 'run.started')).toMatchObject({ agentSessionId: 'fake-session' })
    expect(messages.flatMap(m => m.type === 'run.events' ? m.events : [])).toContainEqual({ type: 'message', text: 'Hello from fake' })
    expect(messages.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
  })
})
