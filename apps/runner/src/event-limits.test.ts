import type { RunEvent } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { batchEvents, capEvent, MAX_BATCH_CHARS, MAX_EVENT_CHARS } from './event-limits.ts'

describe('capEvent', () => {
  it('leaves normal output exactly as it was', () => {
    const events: RunEvent[] = [
      { type: 'message', text: 'x'.repeat(MAX_EVENT_CHARS) },
      { type: 'tool_result', id: 't', output: 'y'.repeat(200_000), isError: false },
      { type: 'tool_call', id: 't', tool: 'Write', input: { file_path: 'a.ts', content: 'z'.repeat(200_000) } },
      { type: 'usage', inputTokens: 1, cacheReadTokens: 2, outputTokens: 3 }
    ]
    for (const event of events) expect(capEvent(event)).toBe(event)
  })

  it('cuts a huge text and says how much went', () => {
    const capped = capEvent({ type: 'tool_result', id: 't', output: 'y'.repeat(MAX_EVENT_CHARS + 5), isError: true })
    expect(capped).toMatchObject({ type: 'tool_result', id: 't', isError: true })
    expect(capped.type === 'tool_result' && capped.output.endsWith('[Cut by Corral: 5 more characters]')).toBe(true)
  })

  it('keeps a tool call readable: its path stays and the huge field is cut', () => {
    const capped = capEvent({ type: 'tool_call', id: 't', tool: 'Write', input: { file_path: 'src/a.ts', content: 'z'.repeat(2 * MAX_EVENT_CHARS) } })
    const input = capped.type === 'tool_call' ? capped.input as { file_path: string, content: string } : null
    expect(input?.file_path).toBe('src/a.ts')
    expect(input?.content).toContain('[Cut by Corral')
    expect(JSON.stringify(input).length).toBeLessThan(MAX_EVENT_CHARS + 1000)
  })

  it('replaces a huge nested or array input with a note', () => {
    expect(capEvent({ type: 'tool_call', id: 't', tool: 'X', input: ['z'.repeat(2 * MAX_EVENT_CHARS)] })).toMatchObject({ input: expect.stringContaining('[Cut by Corral') })
    expect(capEvent({ type: 'tool_call', id: 't', tool: 'X', input: { a: { b: 'z'.repeat(2 * MAX_EVENT_CHARS) } } })).toMatchObject({ input: { a: expect.stringContaining('[Cut by Corral') } })
  })
})

describe('batchEvents', () => {
  it('keeps a normal flush as one batch', () => {
    const events: RunEvent[] = [{ type: 'message', text: 'a' }, { type: 'system', text: 'b' }]
    expect(batchEvents(events)).toEqual([events])
  })

  it('splits in order so each batch stays under the limit', () => {
    const events: RunEvent[] = Array.from({ length: 10 }, (_, i) => ({ type: 'message', text: String(i).repeat(MAX_EVENT_CHARS) }))
    const batches = batchEvents(events)
    expect(batches.length).toBeGreaterThan(1)
    expect(batches.flat()).toEqual(events)
    for (const batch of batches) expect(JSON.stringify(batch).length).toBeLessThan(MAX_BATCH_CHARS + 1000)
  })
})
