import type { RunEvent } from '@corral/contracts'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { CodexJsonParser, parseCodexResetTime } from './codex-json.ts'
import type { ParsedLine } from './stream-json.ts'

// Fixtures are real `codex exec --json` output (codex-cli 0.165.0), except
// usage-limit.jsonl, which uses the message text from the codex binary
function parseFixture(name: string, parser = new CodexJsonParser()): ParsedLine[] {
  const text = readFileSync(join(import.meta.dirname, 'fixtures', 'codex', name), 'utf8')
  return text.split('\n').map(line => parser.parse(line))
}

const events = (lines: ParsedLine[]): RunEvent[] => lines.flatMap(line => line.events)

describe('CodexJsonParser', () => {
  it('turns a run with shell, MCP and file-change items into messages, tool calls, results and usage', () => {
    const lines = parseFixture('tools.jsonl')

    expect(lines[0]!.sessionId).toBe('01a185e9-8f08-7dc1-a6e4-adb2dc3a9e97')
    expect(events(lines)).toEqual([
      { type: 'system', text: 'Session started (Codex)' },
      { type: 'message', text: 'I’ll find the Corral tools, get the task, add the comment, and create `b.txt` before running the requested command.\n' },
      { type: 'tool_call', id: 'item_1', tool: 'Bash', input: { command: expect.stringContaining('rg --files -g AGENTS.md') } },
      { type: 'tool_result', id: 'item_1', output: '/work/repo\n', isError: true },
      { type: 'tool_call', id: 'item_2', tool: 'mcp__corral__get_task', input: {} },
      { type: 'tool_result', id: 'item_2', output: '{\n  "ref": "TA-1",\n  "title": "Say hello"\n}', isError: false },
      { type: 'tool_call', id: 'item_3', tool: 'mcp__corral__add_comment', input: { body: 'hi' } },
      { type: 'tool_result', id: 'item_3', output: 'Comments are closed for this test', isError: true },
      { type: 'tool_call', id: 'item_4', tool: 'Edit', input: { file_path: '/work/repo/b.txt', changes: [{ path: '/work/repo/b.txt', kind: 'add' }] } },
      { type: 'tool_result', id: 'item_4', output: 'add /work/repo/b.txt', isError: false },
      { type: 'tool_call', id: 'item_5', tool: 'Bash', input: { command: 'ls nonexistent-dir' } },
      { type: 'tool_result', id: 'item_5', output: 'ls: cannot access \'nonexistent-dir\': No such file or directory\n', isError: true },
      { type: 'message', text: 'Retrieved “Say hello,” attempted comment “hi” (comments closed), created `b.txt` containing the title, and ran `ls nonexistent-dir` (failed: directory missing).' },
      { type: 'usage', inputTokens: 77491, outputTokens: 299 }
    ])
    const result = lines.find(line => line.result)!.result
    expect(result).toEqual({ isError: false, text: expect.stringMatching(/^Retrieved “Say hello,”/) })
    expect(lines.some(line => line.rateLimit)).toBe(false)
  })

  it('turns reasoning into thinking and keeps a resumed session quiet', () => {
    const lines = parseFixture('resume-reasoning.jsonl', new CodexJsonParser({ quietResumeOf: '01a185e9-8f08-7dc1-a6e4-adb2dc3a9e97' }))

    expect(lines[0]!.sessionId).toBe('01a185e9-8f08-7dc1-a6e4-adb2dc3a9e97')
    expect(events(lines)).toEqual([
      { type: 'thinking', text: expect.stringMatching(/^\*\*Counting prime numbers\*\*/) },
      { type: 'message', text: '21' },
      { type: 'usage', inputTokens: 93800, outputTokens: 347 }
    ])
    expect(lines.find(line => line.result)!.result).toEqual({ isError: false, text: '21' })
  })

  it('ends a failed turn with an error result, not a rate limit', () => {
    const lines = parseFixture('model-error.jsonl')
    const message = 'The \'no-such-model-xyz\' model is not supported when using Codex with a ChatGPT account.'

    expect(events(lines)).toEqual([
      { type: 'system', text: 'Session started (Codex)' },
      { type: 'system', text: expect.stringMatching(/^Model metadata for `no-such-model-xyz` not found/) },
      { type: 'system', text: message },
      { type: 'system', text: 'The agent ended with an error' }
    ])
    expect(lines.find(line => line.result)!.result).toEqual({ isError: true, text: message })
    expect(lines.some(line => line.rateLimit)).toBe(false)
  })

  it('reports a usage limit with the reset time Codex gives', () => {
    const lines = parseFixture('usage-limit.jsonl')
    const resetsAt = new Date(2026, 9, 30, 15, 5).toISOString()

    expect(lines.find(line => line.result)!.result).toMatchObject({ isError: true })
    expect(lines.filter(line => line.rateLimit).map(line => line.rateLimit)).toEqual([{ resetsAt }, { resetsAt }])
    expect(events(lines).at(-1)).toEqual({ type: 'system', text: `Usage limit hit; resets at ${resetsAt}` })
  })

  it('treats a retried stream error as a note, not a rate limit', () => {
    const parsed = new CodexJsonParser().parse(JSON.stringify({ type: 'error', message: 'Reconnecting... 1/5 (stream disconnected: rate limit reached)' }))
    expect(parsed.rateLimit).toBeNull()
    expect(parsed.events).toEqual([{ type: 'system', text: 'Reconnecting... 1/5 (stream disconnected: rate limit reached)' }])
  })

  it('keeps non-JSON output visible', () => {
    expect(new CodexJsonParser().parse('warning: something').events).toEqual([{ type: 'system', text: 'warning: something' }])
  })
})

describe('parseCodexResetTime', () => {
  const now = new Date(2026, 9, 29, 10, 0)

  it('reads a time later today', () => {
    expect(parseCodexResetTime('You\'ve hit your usage limit. Try again at 3:05 PM.', now)).toBe(new Date(2026, 9, 29, 15, 5).toISOString())
  })

  it('reads a clock time already past as tomorrow', () => {
    expect(parseCodexResetTime('You\'ve hit your usage limit. Try again at 9:30 AM.', now)).toBe(new Date(2026, 9, 30, 9, 30).toISOString())
  })

  it('reads a date with or without a year', () => {
    expect(parseCodexResetTime('or try again at Nov 2nd, 2026 12:15 AM.', now)).toBe(new Date(2026, 10, 2, 0, 15).toISOString())
    expect(parseCodexResetTime('Try again at Nov 2 1:00 PM.', now)).toBe(new Date(2026, 10, 2, 13, 0).toISOString())
  })

  it('reads a duration', () => {
    expect(parseCodexResetTime('You\'ve hit your usage limit. Try again in 1 day 2 hours 5 minutes.', now)).toBe(new Date(now.getTime() + (26 * 60 + 5) * 60_000).toISOString())
  })

  it('gives null when there is no time', () => {
    expect(parseCodexResetTime('You\'ve hit your usage limit. Try again later.', now)).toBeNull()
  })
})
