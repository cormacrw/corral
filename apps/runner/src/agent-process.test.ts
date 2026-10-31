import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LineSplitter, MAX_LINE_CHARS, spawnAgent, spawnAgentSession, startProcess } from './agent.ts'
import type { ParsedLine } from './agent-runtime.ts'
import { StreamJsonParser } from './stream-json.ts'

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

describe('LineSplitter', () => {
  function split(chunks: Buffer[]) {
    const lines: string[] = []
    let skipped = 0
    const splitter = new LineSplitter(line => lines.push(line), () => skipped++)
    for (const chunk of chunks) splitter.write(chunk)
    splitter.end()
    return { lines, skipped }
  }

  it('splits on \\n alone, keeping U+2028, U+2029 and \\r inside a line', () => {
    const line = JSON.stringify({ text: 'one two three' })
    expect(line).toContain(' ')
    expect(split([Buffer.from(`${line}\nsecond\rstill second\n`)]).lines).toEqual([line, 'second\rstill second'])
  })

  it('joins a line and a multi-byte character cut across chunks', () => {
    const bytes = Buffer.from('héllo wörld\n')
    expect(split([bytes.subarray(0, 2), bytes.subarray(2, 8), bytes.subarray(8)]).lines).toEqual(['héllo wörld'])
  })

  it('keeps a last line with no newline', () => {
    expect(split([Buffer.from('a\nb')]).lines).toEqual(['a', 'b'])
  })

  it('skips an oversized line once, across chunks, and reads the next', () => {
    const chunk = Buffer.from('x'.repeat(MAX_LINE_CHARS / 2 + 1))
    const { lines, skipped } = split([chunk, chunk, chunk, Buffer.from('tail\nnext\n')])
    expect(lines).toEqual(['next'])
    expect(skipped).toBe(1)
  })
})

describe('an agent process', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'corral-agent-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  async function script(body: string): Promise<string> {
    const bin = join(dir, 'agent')
    await writeFile(bin, `#!/usr/bin/env node\nconst { spawn } = require('node:child_process')\nconst { writeFileSync } = require('node:fs')\nconst pids = ${JSON.stringify(join(dir, 'pid'))}\n${body}`)
    await chmod(bin, 0o755)
    return bin
  }

  const options = (onLine: (raw: string, parsed: ParsedLine) => void = () => {}) => ({ cwd: dir, systemPrompt: '', mcpConfigPath: 'mcp.json', model: null, resumeSessionId: null, gitAuthor: null, onLine })
  const pid = async () => Number(await readFile(join(dir, 'pid'), 'utf8'))

  it('stops what the agent left running once it exits', async () => {
    const bin = await script(`
const child = spawn('sleep', ['60'], { stdio: 'ignore' })
writeFileSync(pids, String(child.pid))
child.unref()
`)
    await spawnAgent({ ...options(), prompt: 'Go', claudeBin: bin }).exited
    const left = await pid()
    await expect.poll(() => alive(left), { timeout: 3000 }).toBe(false)
  })

  it('does not touch the children of a session that is only idle', async () => {
    const bin = await script(`
const child = spawn('sleep', ['60'], { stdio: 'ignore' })
writeFileSync(pids, String(child.pid))
process.stdin.on('data', () => console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done' })))
process.stdin.on('end', () => process.exit(0))
`)
    const session = spawnAgentSession({ ...options(), claudeBin: bin })
    session.send('Go')
    expect(await session.nextResult()).toMatchObject({ isError: false })
    await new Promise(resolve => setTimeout(resolve, 200))
    const left = await pid()
    expect(alive(left)).toBe(true)

    session.close()
    await session.exited
    await expect.poll(() => alive(left), { timeout: 3000 }).toBe(false)
  })

  it('ends even when a process outside the group holds its pipes open', async () => {
    const bin = await script(`
const child = spawn('sleep', ['30'], { stdio: 'inherit', detached: true })
writeFileSync(pids, String(child.pid))
child.unref()
console.log('{"type":"system","subtype":"init","session_id":"s1"}')
`)
    const lines: string[] = []
    const started = Date.now()
    const exit = await spawnAgent({ ...options(raw => lines.push(raw)), prompt: 'Go', claudeBin: bin }).exited
    process.kill(await pid(), 'SIGKILL')

    expect(exit.code).toBe(0)
    expect(Date.now() - started).toBeLessThan(10_000)
    expect(lines).toEqual(['{"type":"system","subtype":"init","session_id":"s1"}'])
  })

  it('turns a parser that throws into a note instead of a crash', async () => {
    const bin = await script('console.log(\'first\'); console.log(\'second\')\n')
    const notes: string[] = []
    const onLine = (raw: string, parsed: ParsedLine) => notes.push(...parsed.events.flatMap(e => e.type === 'system' ? [e.text] : []))
    const { exited } = startProcess(bin, [], 'ignore', { cwd: dir, gitAuthor: null, onLine }, {
      parse() {
        throw new Error('Bad line')
      }
    })
    await exited
    expect(notes).toEqual(['Could not read a line of the agent\'s output: Bad line', 'Could not read a line of the agent\'s output: Bad line'])
  })

  it('shows a null line from the real parser rather than dying on it', async () => {
    const bin = await script('console.log(\'null\'); console.log(\'{"type":"result","subtype":"success","result":"Done"}\')\n')
    const results: unknown[] = []
    const notes: string[] = []
    const { exited } = startProcess(bin, [], 'ignore', { cwd: dir, gitAuthor: null, onLine: (_raw, parsed) => {
      notes.push(...parsed.events.flatMap(e => e.type === 'system' ? [e.text] : []))
      if (parsed.result) results.push(parsed.result)
    } }, new StreamJsonParser())
    await exited
    expect(notes).toEqual(['null'])
    expect(results).toEqual([{ isError: false, text: 'Done' }])
  })
})
