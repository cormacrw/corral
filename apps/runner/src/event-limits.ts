import type { RunEvent } from '@corral/contracts'

// Sizes are in characters, which is close enough. These sit far above normal
// agent output: they only stop a huge line from reaching the server whole,
// where one message past the socket's limit would cut off every run here.
export const MAX_EVENT_CHARS = 256 * 1024
export const MAX_BATCH_CHARS = 1024 * 1024

function cut(text: string, limit: number): string {
  return text.length <= limit ? text : `${text.slice(0, limit)}\n[Cut by Corral: ${(text.length - limit).toLocaleString('en')} more characters]`
}

// Keeps the fields web reads from a tool call, such as file_path
function capInput(input: unknown, size: number): unknown {
  if (typeof input === 'string') return cut(input, MAX_EVENT_CHARS)
  if (typeof input !== 'object' || input === null || Array.isArray(input)) return `[Cut by Corral: ${size.toLocaleString('en')} characters]`
  const fields = Object.entries(input)
  const share = Math.floor(MAX_EVENT_CHARS / fields.length)
  return Object.fromEntries(fields.map(([key, value]) => {
    if (typeof value === 'string') return [key, cut(value, share)]
    const length = JSON.stringify(value)?.length ?? 0
    return [key, length <= share ? value : `[Cut by Corral: ${length.toLocaleString('en')} characters]`]
  }))
}

export function capEvent(event: RunEvent): RunEvent {
  switch (event.type) {
    case 'system':
    case 'message':
    case 'thinking':
      return event.text.length <= MAX_EVENT_CHARS ? event : { ...event, text: cut(event.text, MAX_EVENT_CHARS) }
    case 'tool_result':
      return event.output.length <= MAX_EVENT_CHARS ? event : { ...event, output: cut(event.output, MAX_EVENT_CHARS) }
    case 'tool_call': {
      const size = JSON.stringify(event.input)?.length ?? 0
      return size <= MAX_EVENT_CHARS ? event : { ...event, input: capInput(event.input, size) }
    }
    default:
      return event
  }
}

function eventChars(event: RunEvent): number {
  switch (event.type) {
    case 'tool_result': return event.output.length
    case 'tool_call': return JSON.stringify(event.input)?.length ?? 0
    case 'usage': return 0
    default: return event.text.length
  }
}

// In order, each under MAX_BATCH_CHARS unless a single event is
export function batchEvents(events: RunEvent[]): RunEvent[][] {
  const batches: RunEvent[][] = [[]]
  let size = 0
  for (const event of events) {
    const chars = eventChars(event)
    if (size + chars > MAX_BATCH_CHARS && size > 0) {
      batches.push([])
      size = 0
    }
    batches.at(-1)!.push(event)
    size += chars
  }
  return batches
}
