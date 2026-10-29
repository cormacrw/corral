import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { agentArgs, spawnAgentSession, type AgentSession } from './agent.ts'
import type { ParsedLine } from './stream-json.ts'

// Stands in for `claude --input-format stream-json`: stays alive, reads one
// user message per stdin line and answers each with a result line. A message
// of "hang" starts a turn that never finishes.
const FAKE_CLAUDE = `#!/usr/bin/env node
const { createInterface } = require('node:readline')
let started = false
createInterface({ input: process.stdin }).on('line', (line) => {
  const content = JSON.parse(line).message.content
  if (!started) {
    started = true
    console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'one-session', pid: process.pid }))
  }
  if (content === 'hang') return
  console.log(JSON.stringify({ type: 'assistant', message: { content: [{ type: 'text', text: 'Thinking about ' + content }] } }))
  console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Answered ' + content + ' in ' + process.pid, session_id: 'one-session' }))
})
`

const BASE = { systemPrompt: 'Be helpful', mcpConfigPath: '/tmp/mcp.json', model: null, resumeSessionId: null }

describe('agentArgs', () => {
  it('reads turns from stdin in the session mode, with no -p', () => {
    const args = agentArgs({ ...BASE, input: 'stream-json' })
    expect(args).not.toContain('-p')
    expect(args.join(' ')).toContain('--input-format stream-json')
    expect(args.join(' ')).toContain('--output-format stream-json')
    // The CLI only reads stdin messages in print mode
    expect(args).toContain('--print')
  })

  it('still passes the prompt with -p for one-shot runs', () => {
    expect(agentArgs({ ...BASE, prompt: 'Do the task', model: 'opus', resumeSessionId: 's1' })).toEqual([
      '-p', 'Do the task',
      '--output-format', 'stream-json',
      '--verbose',
      '--mcp-config', '/tmp/mcp.json',
      '--strict-mcp-config',
      '--permission-mode', 'bypassPermissions',
      '--append-system-prompt', 'Be helpful',
      '--model', 'opus',
      '--resume', 's1'
    ])
  })
})

describe('spawnAgentSession', () => {
  let root: string
  let claudeBin: string
  let lines: ParsedLine[]
  let session: AgentSession | null

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'corral-agent-session-'))
    claudeBin = join(root, 'claude')
    await writeFile(claudeBin, FAKE_CLAUDE)
    await chmod(claudeBin, 0o755)
    lines = []
    session = null
  })

  afterEach(async () => {
    session?.kill('SIGKILL')
    await session?.exited
    await rm(root, { recursive: true, force: true })
  })

  function start(): AgentSession {
    session = spawnAgentSession({ ...BASE, claudeBin, cwd: root, gitAuthor: null, onLine: (_raw, parsed) => lines.push(parsed) })
    return session
  }

  it('takes two turns in one process, with one result per turn in order', async () => {
    const agent = start()
    agent.send('first')
    const first = await agent.nextResult()
    agent.send('second')
    const second = await agent.nextResult()

    expect(first).toEqual({ isError: false, text: `Answered first in ${agent.pid}` })
    expect(second).toEqual({ isError: false, text: `Answered second in ${agent.pid}` })
    expect(lines.filter(line => line.result).map(line => line.result!.text)).toEqual([first!.text, second!.text])
    expect(lines.filter(line => line.sessionId).map(line => line.sessionId)).toEqual(['one-session'])
  })

  it('keeps results that arrive before anyone asks for them, in order', async () => {
    const agent = start()
    agent.send('a')
    agent.send('b')
    await expect.poll(() => lines.filter(line => line.result).length).toBe(2)
    expect((await agent.nextResult())?.text).toMatch(/^Answered a/)
    expect((await agent.nextResult())?.text).toMatch(/^Answered b/)
  })

  it('resolves exited and the pending turn when killed mid-turn', async () => {
    const agent = start()
    agent.send('hang')
    await expect.poll(() => lines.some(line => line.sessionId)).toBe(true)
    const pending = agent.nextResult()
    agent.kill('SIGTERM')

    expect(await agent.exited).toEqual({ code: null, signal: 'SIGTERM' })
    expect(await pending).toBeNull()
    // Later calls neither hang nor throw
    expect(await agent.nextResult()).toBeNull()
    agent.send('too late')
  })
})
