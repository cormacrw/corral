import { describe, expect, it } from 'vitest'
import { parseResetTime, StreamJsonParser } from './stream-json.ts'

const line = (data: unknown) => JSON.stringify(data)

describe('StreamJsonParser', () => {
  it('reads the session ID from the init line', () => {
    const parser = new StreamJsonParser()
    const parsed = parser.parse(line({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-fable-5-1' }))
    expect(parsed.sessionId).toBe('sess-1')
    expect(parser.sessionId).toBe('sess-1')
    expect(parsed.events).toEqual([{ type: 'system', text: 'Session started (claude-fable-5-1)' }])
  })

  it('ignores hook lines and blank lines', () => {
    const parser = new StreamJsonParser()
    expect(parser.parse(line({ type: 'system', subtype: 'hook_started', session_id: 's' })).events).toEqual([])
    expect(parser.parse('   ').events).toEqual([])
  })

  it('turns assistant text and tool use into events with running token totals', () => {
    const parser = new StreamJsonParser()
    const first = parser.parse(line({
      type: 'assistant',
      message: {
        content: [{ type: 'text', text: 'Looking at the task.' }, { type: 'tool_use', id: 'toolu_1', name: 'mcp__corral__get_task', input: {} }],
        usage: { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 10, output_tokens: 4 }
      }
    }))
    expect(first.events).toEqual([
      { type: 'message', text: 'Looking at the task.' },
      { type: 'tool_call', id: 'toolu_1', tool: 'mcp__corral__get_task', input: {} },
      { type: 'usage', inputTokens: 112, outputTokens: 4 }
    ])
    const second = parser.parse(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }], usage: { input_tokens: 1, output_tokens: 1 } } }))
    expect(second.events.at(-1)).toEqual({ type: 'usage', inputTokens: 113, outputTokens: 5 })
  })

  it('turns thinking blocks into events, with or without text', () => {
    const parser = new StreamJsonParser()
    const parsed = parser.parse(line({
      type: 'assistant',
      message: {
        content: [
          { type: 'thinking', thinking: 'Check the parser first.', signature: 'sig' },
          { type: 'thinking', thinking: '', signature: 'sig' },
          { type: 'thinking', signature: 'sig' },
          { type: 'redacted_thinking', data: 'abc' },
          { type: 'text', text: 'Found it.' }
        ]
      }
    }))
    expect(parsed.events).toEqual([
      { type: 'thinking', text: 'Check the parser first.' },
      { type: 'thinking', text: '' },
      { type: 'thinking', text: '' },
      { type: 'thinking', text: '' },
      { type: 'message', text: 'Found it.' }
    ])
  })

  it('turns tool results into events, flattening text parts', () => {
    const parser = new StreamJsonParser()
    const parsed = parser.parse(line({
      type: 'user',
      message: { content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: [{ type: 'text', text: 'ok' }], is_error: false }] }
    }))
    expect(parsed.events).toEqual([{ type: 'tool_result', id: 'toolu_1', output: 'ok', isError: false }])
  })

  it('reports a usage limit from a rate_limit_event with its reset time', () => {
    const parser = new StreamJsonParser()
    const allowed = parser.parse(line({ type: 'rate_limit_event', rate_limit_info: { status: 'allowed', resetsAt: 1793160600 } }))
    expect(allowed.rateLimit).toBeNull()
    const limited = parser.parse(line({ type: 'rate_limit_event', rate_limit_info: { status: 'rejected', resetsAt: 1793160600 } }))
    expect(limited.rateLimit).toEqual({ resetsAt: '2026-10-28T04:10:00.000Z' })
  })

  it('reports a usage limit from an error result that mentions it', () => {
    const parser = new StreamJsonParser()
    const parsed = parser.parse(line({ type: 'result', subtype: 'error_during_execution', is_error: true, result: 'You’ve hit your limit · resets 2026-10-28T15:00:00Z' }))
    expect(parsed.result).toEqual({ isError: true, text: 'You’ve hit your limit · resets 2026-10-28T15:00:00Z' })
    expect(parsed.rateLimit).toEqual({ resetsAt: '2026-10-28T15:00:00.000Z' })
  })

  it('reports a successful result without a usage limit', () => {
    const parser = new StreamJsonParser()
    const parsed = parser.parse(line({ type: 'result', subtype: 'success', is_error: false, result: 'Finished', session_id: 's' }))
    expect(parsed.result).toEqual({ isError: false, text: 'Finished' })
    expect(parsed.rateLimit).toBeNull()
  })

  it('keeps non-JSON output visible as a system event', () => {
    const parser = new StreamJsonParser()
    expect(parser.parse('warning: something').events).toEqual([{ type: 'system', text: 'warning: something' }])
  })
})

describe('parseResetTime', () => {
  const now = new Date('2026-10-28T10:00:00')

  it('reads a clock time later today', () => {
    expect(parseResetTime('resets 3pm (Europe/London)', now)).toBe(new Date('2026-10-28T15:00:00').toISOString())
  })

  it('rolls a clock time already past to tomorrow', () => {
    expect(parseResetTime('resets at 9am', now)).toBe(new Date('2026-10-29T09:00:00').toISOString())
  })

  it('returns null when there is no time', () => {
    expect(parseResetTime('limit reached', now)).toBeNull()
  })
})
