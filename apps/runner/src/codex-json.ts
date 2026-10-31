import type { RunEvent } from '@corral/contracts'
import { LIMIT_TEXT, parseJsonLine, parseResetTime, resultText, type ParsedLine } from './stream-json.ts'

// Turns `codex exec --json` lines into Corral's runtime-neutral RunEvents
// (agent-runtime-and-auth.md rule 7), the same shape StreamJsonParser gives
// for Claude Code. One parser per process.
//
// Codex prints a thread (its session), then items: each tool-like item comes
// as item.started and again as item.completed with its output. Messages and
// reasoning only come completed. turn.completed carries the turn's usage,
// where input_tokens already includes the cached ones.

interface CodexItem {
  id?: string
  type?: string
  text?: string
  message?: string
  // command_execution
  command?: string
  aggregated_output?: string
  exit_code?: number | null
  status?: string
  // file_change
  changes?: { path?: string, kind?: string }[]
  // mcp_tool_call
  server?: string
  tool?: string
  arguments?: unknown
  result?: { content?: unknown } | null
  error?: { message?: string } | null
  // web_search
  query?: string
  // todo_list
  items?: unknown
}

interface CodexLine {
  type?: string
  thread_id?: string
  item?: CodexItem
  // input_tokens includes cached_input_tokens
  usage?: { input_tokens?: number, cached_input_tokens?: number, output_tokens?: number }
  message?: string
  error?: { message?: string }
}

export class CodexJsonParser {
  #inputTokens = 0
  #cacheReadTokens = 0
  #outputTokens = 0
  #started = new Set<string>()
  #lastMessage = ''
  #lastError = ''
  sessionId: string | null = null
  #quietResumeOf: string | null

  constructor(options: { quietResumeOf?: string | null } = {}) {
    this.#quietResumeOf = options.quietResumeOf ?? null
  }

  parse(line: string): ParsedLine {
    const { out, data } = parseJsonLine<CodexLine>(line)
    if (!data) return out

    switch (data.type) {
      case 'thread.started':
        if (!data.thread_id) return out
        out.sessionId = data.thread_id
        if (this.sessionId) return out
        this.sessionId = data.thread_id
        if (this.#quietResumeOf !== data.thread_id) out.events.push({ type: 'system', text: 'Session started (Codex)' })
        return out

      case 'item.started':
        if (data.item) this.#call(data.item, out.events)
        return out

      case 'item.updated':
        return out

      case 'item.completed':
        if (data.item) this.#completed(data.item, out.events)
        return out

      case 'turn.completed':
        if (data.usage) {
          const cached = data.usage.cached_input_tokens ?? 0
          this.#inputTokens += (data.usage.input_tokens ?? 0) - cached
          this.#cacheReadTokens += cached
          this.#outputTokens += data.usage.output_tokens ?? 0
          out.events.push({ type: 'usage', inputTokens: this.#inputTokens, cacheReadTokens: this.#cacheReadTokens, outputTokens: this.#outputTokens })
        }
        out.result = { isError: false, text: this.#lastMessage }
        return out

      // A stream error. Codex retries some ("Reconnecting... 1/5"); the fatal
      // ones are followed by turn.failed with the same message.
      case 'error': {
        const text = data.message ?? ''
        this.#lastError = text
        if (text) out.events.push({ type: 'system', text })
        out.rateLimit = usageLimit(text)
        return out
      }

      case 'turn.failed': {
        const text = data.error?.message ?? ''
        out.result = { isError: true, text }
        out.rateLimit = usageLimit(text)
        if (out.rateLimit) out.events.push({ type: 'system', text: `Usage limit hit${out.rateLimit.resetsAt ? `; resets at ${out.rateLimit.resetsAt}` : ''}` })
        else out.events.push({ type: 'system', text: `The agent ended with an error${text && text !== this.#lastError ? `: ${text}` : ''}` })
        return out
      }

      default:
        return out
    }
  }

  // The tool call an item stands for, once per item
  #call(item: CodexItem, events: RunEvent[]): void {
    const id = item.id ?? ''
    if (this.#started.has(id)) return
    const call = toolCall(item)
    if (!call) return
    this.#started.add(id)
    events.push({ type: 'tool_call', id, ...call })
  }

  #completed(item: CodexItem, events: RunEvent[]): void {
    switch (item.type) {
      case 'agent_message':
        if (item.text?.trim()) {
          this.#lastMessage = item.text
          events.push({ type: 'message', text: item.text })
        }
        return
      case 'reasoning':
        events.push({ type: 'thinking', text: item.text ?? '' })
        return
      // A warning, not the end of the turn
      case 'error':
        if (item.message) events.push({ type: 'system', text: item.message })
        return
      default: {
        this.#call(item, events)
        const result = toolResult(item)
        if (result && this.#started.has(item.id ?? '')) events.push({ type: 'tool_result', id: item.id ?? '', ...result })
      }
    }
  }
}

// Named like Claude Code's tools where one matches, so the transcript
// describes them the same way (web's tool-steps.ts)
function toolCall(item: CodexItem): { tool: string, input: unknown } | null {
  switch (item.type) {
    case 'command_execution':
      return { tool: 'Bash', input: { command: unwrapShell(item.command ?? '') } }
    case 'file_change': {
      const paths = (item.changes ?? []).map(change => change.path ?? '')
      return { tool: 'Edit', input: { file_path: paths[0] ?? '', changes: item.changes ?? [] } }
    }
    case 'mcp_tool_call':
      return { tool: `mcp__${item.server ?? ''}__${item.tool ?? ''}`, input: item.arguments ?? {} }
    case 'web_search':
      return { tool: 'WebSearch', input: { query: item.query ?? '' } }
    case 'todo_list':
      return { tool: 'TodoWrite', input: { items: item.items ?? [] } }
    default:
      return null
  }
}

function toolResult(item: CodexItem): { output: string, isError: boolean } | null {
  const failed = item.status === 'failed'
  switch (item.type) {
    case 'command_execution':
      return { output: item.aggregated_output ?? '', isError: failed || (item.exit_code !== null && item.exit_code !== undefined && item.exit_code !== 0) }
    case 'file_change':
      return { output: (item.changes ?? []).map(change => `${change.kind ?? 'update'} ${change.path ?? ''}`).join('\n'), isError: failed }
    case 'mcp_tool_call':
      return { output: item.error?.message ?? resultText(item.result?.content), isError: failed || Boolean(item.error) }
    case 'web_search':
    case 'todo_list':
      return { output: '', isError: failed }
    default:
      return null
  }
}

// Codex runs commands as `/bin/sh -lc '<command>'`; show just the command
function unwrapShell(command: string): string {
  const match = /^\/bin\/(?:ba)?sh -lc '([^']*)'$/.exec(command)
  return match ? match[1]! : command
}

function usageLimit(text: string): { resetsAt: string | null } | null {
  if (!text || /^Reconnecting/i.test(text) || !LIMIT_TEXT.test(text)) return null
  return { resetsAt: parseCodexResetTime(text) }
}

const MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec']

// Codex says when a limit resets in the runner's local time: "Try again at
// 3:05 PM." on the same day, "try again at Oct 30th, 2026 3:05 PM." later,
// or "try again in 2 days 3 hours 5 minutes". Null when it gives no time (D3).
export function parseCodexResetTime(text: string, now = new Date()): string | null {
  const dated = /try again at (\w{3})\w* (\d{1,2})(?:st|nd|rd|th)?,? (?:(\d{4}) )?(\d{1,2}):(\d{2}) ?(AM|PM)?/i.exec(text)
  if (dated) {
    const month = MONTHS.indexOf(dated[1]!.toLowerCase())
    if (month >= 0) {
      const at = new Date(Number(dated[3] ?? now.getFullYear()), month, Number(dated[2]), hours24(Number(dated[4]), dated[6]), Number(dated[5]))
      if (!dated[3] && at < now) at.setFullYear(at.getFullYear() + 1)
      return at.toISOString()
    }
  }
  const clock = /try again at (\d{1,2}):(\d{2}) ?(AM|PM)?/i.exec(text)
  if (clock) {
    const at = new Date(now)
    at.setHours(hours24(Number(clock[1]), clock[3]), Number(clock[2]), 0, 0)
    if (at <= now) at.setDate(at.getDate() + 1)
    return at.toISOString()
  }
  const relative = /try again in ([^.]+)/i.exec(text)
  if (relative) {
    const units: Record<string, number> = { day: 86_400, hour: 3_600, minute: 60, second: 1 }
    let seconds = 0
    for (const [, n, unit] of relative[1]!.matchAll(/(\d+)\s*(day|hour|minute|second)s?/gi)) seconds += Number(n) * units[unit!.toLowerCase()]!
    if (seconds > 0) return new Date(now.getTime() + seconds * 1000).toISOString()
  }
  return parseResetTime(text, now)
}

function hours24(hours: number, meridiem: string | undefined): number {
  const m = meridiem?.toUpperCase()
  if (m === 'PM' && hours < 12) return hours + 12
  if (m === 'AM' && hours === 12) return 0
  return hours
}
