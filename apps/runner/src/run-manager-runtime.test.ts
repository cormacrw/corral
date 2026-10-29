import type { RunnerMessage } from '@corral/contracts'
import { rm } from 'node:fs/promises'
import { dirname } from 'node:path'
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
    config = { dataDir, claudeBin: '/nonexistent/claude', name: 'test', serverUrl: new URL('http://127.0.0.1:9'), gitAuthor: null, pmWarmSeconds: 300 }
    sent = []
  })

  afterEach(async () => {
    await rm(dirname(dataDir), { recursive: true, force: true })
  })

  async function finish(runId: string) {
    await expect.poll(() => sent.find(m => m.type === 'run.ended' && m.runId === runId), { timeout: 10_000 }).toBeTruthy()
    return sent.filter(m => 'runId' in m && m.runId === runId)
  }

  it('registers Claude Code as claude-code', () => {
    const registry = createRuntimeRegistry(config)
    expect([...registry.keys()]).toEqual(['claude-code'])
    expect(registry.get('claude-code')?.spawnSession).toBeTypeOf('function')
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
