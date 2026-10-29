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

  it('drops the start note when the init line resumes the quiet session', () => {
    const parser = new StreamJsonParser({ quietResumeOf: 'sess-1' })
    const parsed = parser.parse(line({ type: 'system', subtype: 'init', session_id: 'sess-1', model: 'claude-fable-5-1' }))
    expect(parsed.sessionId).toBe('sess-1')
    expect(parsed.events).toEqual([])
  })

  it('keeps the start note when the init line starts a different session', () => {
    const parser = new StreamJsonParser({ quietResumeOf: 'sess-1' })
    const parsed = parser.parse(line({ type: 'system', subtype: 'init', session_id: 'sess-2', model: 'claude-fable-5-1' }))
    expect(parsed.sessionId).toBe('sess-2')
    expect(parsed.events).toEqual([{ type: 'system', text: 'Session started (claude-fable-5-1)' }])
  })

  it('announces a long-lived session once, even if later turns repeat the init line', () => {
    const parser = new StreamJsonParser()
    parser.parse(line({ type: 'system', subtype: 'init', session_id: 'sess-1' }))
    const again = parser.parse(line({ type: 'system', subtype: 'init', session_id: 'sess-1' }))
    expect(again.sessionId).toBe('sess-1')
    expect(again.events).toEqual([])
  })

  it('starts token totals again for each turn of a long-lived session', () => {
    const parser = new StreamJsonParser()
    const usage = { input_tokens: 10, output_tokens: 2 }
    parser.parse(line({ type: 'assistant', message: { content: [], usage } }))
    parser.startTurn()
    const next = parser.parse(line({ type: 'assistant', message: { content: [], usage } }))
    expect(next.events).toEqual([{ type: 'usage', inputTokens: 10, cacheReadTokens: 0, outputTokens: 2 }])
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
      { type: 'usage', inputTokens: 102, cacheReadTokens: 10, outputTokens: 4 }
    ])
    const second = parser.parse(line({ type: 'assistant', message: { content: [{ type: 'text', text: 'Done' }], usage: { input_tokens: 1, output_tokens: 1 } } }))
    expect(second.events.at(-1)).toEqual({ type: 'usage', inputTokens: 103, cacheReadTokens: 10, outputTokens: 5 })
  })

  it('counts the usage of an API message once across its content block lines', () => {
    const parser = new StreamJsonParser()
    const usage = { input_tokens: 2, cache_creation_input_tokens: 100, cache_read_input_tokens: 10, output_tokens: 6 }
    const first = parser.parse(line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'thinking', thinking: 'Hmm' }], usage } }))
    expect(first.events.at(-1)).toEqual({ type: 'usage', inputTokens: 102, cacheReadTokens: 10, outputTokens: 6 })
    const second = parser.parse(line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} }], usage } }))
    expect(second.events).toEqual([{ type: 'tool_call', id: 'toolu_1', tool: 'Read', input: {} }])
  })

  it('adds up the usage of different API messages', () => {
    const parser = new StreamJsonParser()
    parser.parse(line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 10, output_tokens: 1 } } }))
    parser.parse(line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'b' }], usage: { input_tokens: 10, output_tokens: 1 } } }))
    const third = parser.parse(line({ type: 'assistant', message: { id: 'msg_2', content: [{ type: 'text', text: 'c' }], usage: { input_tokens: 20, output_tokens: 2 } } }))
    expect(third.events.at(-1)).toEqual({ type: 'usage', inputTokens: 30, cacheReadTokens: 0, outputTokens: 3 })
  })

  it('counts cache reads apart from fresh input, which keeps cache writes', () => {
    const parser = new StreamJsonParser()
    parser.parse(line({ type: 'assistant', message: { id: 'msg_1', content: 'a', usage: { input_tokens: 3, cache_creation_input_tokens: 500, cache_read_input_tokens: 20000, output_tokens: 7 } } }))
    const next = parser.parse(line({ type: 'assistant', message: { id: 'msg_2', content: 'b', usage: { input_tokens: 2, cache_creation_input_tokens: 40, cache_read_input_tokens: 20500, output_tokens: 9 } } }))
    expect(next.events.at(-1)).toEqual({ type: 'usage', inputTokens: 545, cacheReadTokens: 40500, outputTokens: 16 })
  })

  it('takes the result usage as the final figure for the turn', () => {
    const parser = new StreamJsonParser()
    parser.parse(line({ type: 'assistant', message: { id: 'msg_1', content: [{ type: 'text', text: 'a' }], usage: { input_tokens: 10, output_tokens: 1 } } }))
    const result = parser.parse(line({
      type: 'result', subtype: 'success', is_error: false, result: 'Done',
      usage: { input_tokens: 4, cache_creation_input_tokens: 12398, cache_read_input_tokens: 31842, output_tokens: 369 }
    }))
    expect(result.events.filter(e => e.type === 'usage').at(-1)).toEqual({ type: 'usage', inputTokens: 12402, cacheReadTokens: 31842, outputTokens: 369 })
  })

  it('adds each turn result of a long-lived session to the earlier turns', () => {
    const parser = new StreamJsonParser()
    parser.parse(line({ type: 'assistant', message: { id: 'msg_1', content: 'hi', usage: { input_tokens: 10, output_tokens: 1 } } }))
    parser.parse(line({ type: 'result', subtype: 'success', result: 'hi', usage: { input_tokens: 10, output_tokens: 40 } }))
    const next = parser.parse(line({ type: 'assistant', message: { id: 'msg_2', content: 'bye', usage: { input_tokens: 20, output_tokens: 1 } } }))
    expect(next.events.at(-1)).toEqual({ type: 'usage', inputTokens: 30, cacheReadTokens: 0, outputTokens: 41 })
    const result = parser.parse(line({ type: 'result', subtype: 'success', result: 'bye', usage: { input_tokens: 20, output_tokens: 25 } }))
    expect(result.events.at(-1)).toEqual({ type: 'usage', inputTokens: 30, cacheReadTokens: 0, outputTokens: 65 })
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
