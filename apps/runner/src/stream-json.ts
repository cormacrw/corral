import type { RunEvent } from '@corral/contracts'

// Turns Claude Code's `--output-format stream-json` lines into Corral's
// runtime-neutral RunEvents (agent-runtime-and-auth.md rule 7). One parser
// per process: it keeps running token totals and remembers the session ID.
//
// The CLI prints one `assistant` line per content block, each repeating its
// API message's ID and usage, so a message's usage is counted only the first
// time its ID is seen. That usage is a streaming snapshot (its output_tokens
// is low), so each turn's `result` usage, when present, replaces the running
// figure for that turn. A long-lived session's results each cover one turn.

export interface ParsedLine {
  events: RunEvent[]
  // Set on the session's init line
  sessionId: string | null
  // Set when the CLI reports it hit a usage limit (D3)
  rateLimit: { resetsAt: string | null } | null
  // Set on the final result line
  result: { isError: boolean, text: string } | null
  // A user message the CLI echoes as it takes it in (--replay-user-messages),
  // whether it starts a turn or joins the one under way
  replayed?: string
  // A result that took no model turn. A resumed session prints one for the
  // background commands its last process left behind, ahead of the new prompt
  emptyTurn?: boolean
}

interface ContentBlock {
  type: string
  text?: string
  thinking?: string
  id?: string
  name?: string
  input?: unknown
  tool_use_id?: string
  content?: unknown
  is_error?: boolean
}

interface Usage {
  input_tokens?: number
  output_tokens?: number
  cache_creation_input_tokens?: number
  cache_read_input_tokens?: number
}

interface StreamLine {
  type: string
  subtype?: string
  session_id?: string
  model?: string
  message?: { id?: string, content?: ContentBlock[] | string, usage?: Usage }
  rate_limit_info?: { status?: string, resetsAt?: number }
  is_error?: boolean
  result?: string
  isReplay?: boolean
  num_turns?: number
  errors?: unknown[]
  usage?: Usage
}

// What the CLI prints when a subscription or API limit is exhausted
export const LIMIT_TEXT = /usage limit|hit your limit|rate limit|limit reached|out of extra usage/i

// A line of JSONL as an object, or null with what to show instead. A line that
// isn't one means the CLI printed something else (e.g. a warning): it stays visible.
export function parseJsonLine<T extends object>(line: string): { out: ParsedLine, data: T | null } {
  const out: ParsedLine = { events: [], sessionId: null, rateLimit: null, result: null }
  const trimmed = line.trim()
  if (!trimmed) return { out, data: null }
  try {
    const data: unknown = JSON.parse(trimmed)
    if (typeof data === 'object' && data !== null) return { out, data: data as T }
  } catch { /* Shown below */ }
  out.events.push({ type: 'system', text: trimmed })
  return { out, data: null }
}

export class StreamJsonParser {
  #inputTokens = 0
  #cacheReadTokens = 0
  #outputTokens = 0
  // Totals at the end of the last turn that reported a result
  #turnStart = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
  #countedMessages = new Set<string>()
  sessionId: string | null = null
  // A follow-up turn that resumes this session gets no "Session started" note
  #quietResumeOf: string | null
  #sawInit = false

  constructor(options: { quietResumeOf?: string | null } = {}) {
    this.#quietResumeOf = options.quietResumeOf ?? null
  }

  parse(line: string): ParsedLine {
    const { out, data } = parseJsonLine<StreamLine>(line)
    if (!data) return out
    if (data.session_id && !this.sessionId) {
      this.sessionId = data.session_id
      out.sessionId = data.session_id
    }

    switch (data.type) {
      case 'system':
        if (data.subtype === 'init') {
          out.sessionId = data.session_id ?? null
          if (this.#quietResumeOf && data.session_id === this.#quietResumeOf) return out
          // A long-lived session may announce itself again on later turns
          if (this.#sawInit) return out
          this.#sawInit = true
          out.events.push({ type: 'system', text: `Session started${data.model ? ` (${data.model})` : ''}` })
        }
        return out

      case 'assistant': {
        for (const block of blocks(data.message?.content)) {
          if (block.type === 'text' && block.text?.trim()) out.events.push({ type: 'message', text: block.text })
          // Kept even when empty, so the transcript shows that the agent thought
          if (block.type === 'thinking' || block.type === 'redacted_thinking') out.events.push({ type: 'thinking', text: block.thinking ?? '' })
          if (block.type === 'tool_use') out.events.push({ type: 'tool_call', id: block.id ?? '', tool: block.name ?? '', input: block.input })
        }
        const messageId = data.message?.id
        if (data.message?.usage && !(messageId && this.#countedMessages.has(messageId))) {
          if (messageId) this.#countedMessages.add(messageId)
          this.#add(data.message.usage)
          out.events.push(this.#usage())
        }
        return out
      }

      case 'user':
        if (data.isReplay) out.replayed = blocks(data.message?.content).flatMap(block => block.type === 'text' ? [block.text ?? ''] : []).join('\n')
        for (const block of blocks(data.message?.content)) {
          if (block.type === 'tool_result') {
            out.events.push({ type: 'tool_result', id: block.tool_use_id ?? '', output: resultText(block.content), isError: block.is_error === true })
          }
        }
        return out

      case 'rate_limit_event': {
        const info = data.rate_limit_info
        // Only `rejected` refuses requests; `allowed_warning` is a heads-up that
        // comes with the window's reset time while the agent keeps working
        if (info?.status === 'rejected') {
          const at = new Date((info.resetsAt ?? 0) * 1000)
          out.rateLimit = { resetsAt: info.resetsAt && !Number.isNaN(at.getTime()) ? at.toISOString() : null }
          out.events.push({ type: 'system', text: `Usage limit hit${out.rateLimit.resetsAt ? `; resets at ${out.rateLimit.resetsAt}` : ''}` })
        }
        return out
      }

      case 'result': {
        const isError = data.is_error === true || (data.subtype !== undefined && data.subtype !== 'success')
        const text = data.result ?? (Array.isArray(data.errors) ? data.errors.map(String).join('\n') : '') ?? ''
        out.result = { isError, text }
        if (!isError && data.num_turns === 0) out.emptyTurn = true
        if (isError && LIMIT_TEXT.test(text)) out.rateLimit = { resetsAt: parseResetTime(text) }
        if (isError) out.events.push({ type: 'system', text: `The agent ended with an error: ${text || data.subtype}` })
        if (data.usage) {
          this.#inputTokens = this.#turnStart.inputTokens
          this.#cacheReadTokens = this.#turnStart.cacheReadTokens
          this.#outputTokens = this.#turnStart.outputTokens
          this.#add(data.usage)
          out.events.push(this.#usage())
        }
        this.#turnStart = { inputTokens: this.#inputTokens, cacheReadTokens: this.#cacheReadTokens, outputTokens: this.#outputTokens }
        return out
      }

      default:
        return out
    }
  }

  // A long-lived session's next turn is a new run, whose totals start at zero
  startTurn(): void {
    this.#inputTokens = 0
    this.#cacheReadTokens = 0
    this.#outputTokens = 0
    this.#turnStart = { inputTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
  }

  // Cache reads are kept apart: they cost far less than fresh input
  #add(usage: Usage): void {
    this.#inputTokens += (usage.input_tokens ?? 0) + (usage.cache_creation_input_tokens ?? 0)
    this.#cacheReadTokens += usage.cache_read_input_tokens ?? 0
    this.#outputTokens += usage.output_tokens ?? 0
  }

  #usage(): RunEvent {
    return { type: 'usage', inputTokens: this.#inputTokens, cacheReadTokens: this.#cacheReadTokens, outputTokens: this.#outputTokens }
  }
}

function blocks(content: ContentBlock[] | string | undefined): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}

export function resultText(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map(part => (typeof part === 'object' && part && 'text' in part ? String((part as { text: unknown }).text) : '[non-text content]')).join('\n')
  }
  return content === undefined || content === null ? '' : JSON.stringify(content)
}

// Error text such as "resets 3pm (Europe/London)" or "resets at 2026-10-28T15:00:00Z"
// gives a reset time when it can be read; otherwise the scheduler backs off (D3)
export function parseResetTime(text: string, now = new Date()): string | null {
  const iso = /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2})?(?:Z|[+-]\d{2}:\d{2})?/.exec(text)
  if (iso && !Number.isNaN(Date.parse(iso[0]))) return new Date(iso[0]).toISOString()
  const clock = /resets?(?: at)?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?(?:\s*\(([^)]+)\))?/i.exec(text)
  if (!clock) return null
  let hours = Number(clock[1])
  const minutes = Number(clock[2] ?? '0')
  const meridiem = clock[3]?.toLowerCase()
  if (meridiem === 'pm' && hours < 12) hours += 12
  if (meridiem === 'am' && hours === 12) hours = 0
  const zoned = clock[4] ? nextTimeInZone(hours, minutes, clock[4], now) : null
  if (zoned) return zoned.toISOString()
  const at = new Date(now)
  at.setHours(hours, minutes, 0, 0)
  if (at <= now) at.setDate(at.getDate() + 1)
  return at.toISOString()
}

// What a zone's clock reads at an instant, as if that reading were UTC
function wallClock(at: number, timeZone: string): number {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone, hourCycle: 'h23', year: 'numeric', month: 'numeric', day: 'numeric', hour: 'numeric', minute: 'numeric', second: 'numeric' }).formatToParts(at)
  const part = (type: Intl.DateTimeFormatPartTypes) => Number(parts.find(p => p.type === type)?.value)
  return Date.UTC(part('year'), part('month') - 1, part('day'), part('hour'), part('minute'), part('second'))
}

// The next time a zone's clock reads hours:minutes, or null for a zone Intl
// doesn't know. The offset is worked out twice, in case the first guess landed
// on the other side of a daylight-saving change.
function nextTimeInZone(hours: number, minutes: number, timeZone: string, now: Date): Date | null {
  try {
    const today = new Date(wallClock(now.getTime(), timeZone))
    for (const days of [0, 1]) {
      const wall = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate() + days, hours, minutes)
      const guess = wall - (wallClock(wall, timeZone) - wall)
      const at = wall - (wallClock(guess, timeZone) - guess)
      if (at > now.getTime()) return new Date(at)
    }
    return null
  } catch {
    return null
  }
}
