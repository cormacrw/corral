import type { RunEvent } from '@corral/contracts'
import { LIMIT_TEXT, parseJsonLine, parseResetTime, resultText, type ParsedLine } from './parsed-line.ts'

// Turns Claude Code's `--output-format stream-json` lines into Corral's
// runtime-neutral RunEvents (agent-runtime-and-auth.md rule 7). One parser
// per process: it keeps running token totals and remembers the session ID.
//
// The CLI prints one `assistant` line per content block, each repeating its
// API message's ID and usage, so a message's usage is counted only the first
// time its ID is seen. That usage is a streaming snapshot (its output_tokens
// is low), so each turn's `result` usage, when present, replaces the running
// figure for that turn. A long-lived session's results each cover one turn.

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
  local_command?: string
  errors?: unknown[]
  usage?: Usage
}

export class StreamJsonParser {
  #inputTokens = 0
  #cacheWriteTokens = 0
  #cacheReadTokens = 0
  #outputTokens = 0
  // Totals at the end of the last turn that reported a result
  #turnStart = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
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
        if (!isError && data.num_turns === 0 && !text && !data.local_command) out.emptyTurn = true
        if (isError && LIMIT_TEXT.test(text)) out.rateLimit = { resetsAt: parseResetTime(text) }
        if (isError) out.events.push({ type: 'system', text: `The agent ended with an error: ${text || data.subtype}` })
        if (data.usage) {
          this.#inputTokens = this.#turnStart.inputTokens
          this.#cacheWriteTokens = this.#turnStart.cacheWriteTokens
          this.#cacheReadTokens = this.#turnStart.cacheReadTokens
          this.#outputTokens = this.#turnStart.outputTokens
          this.#add(data.usage)
          out.events.push(this.#usage())
        }
        this.#turnStart = { inputTokens: this.#inputTokens, cacheWriteTokens: this.#cacheWriteTokens, cacheReadTokens: this.#cacheReadTokens, outputTokens: this.#outputTokens }
        return out
      }

      default:
        return out
    }
  }

  // A long-lived session's next turn is a new run, whose totals start at zero
  startTurn(): void {
    this.#inputTokens = 0
    this.#cacheWriteTokens = 0
    this.#cacheReadTokens = 0
    this.#outputTokens = 0
    this.#turnStart = { inputTokens: 0, cacheWriteTokens: 0, cacheReadTokens: 0, outputTokens: 0 }
  }

  // Cache writes and reads are kept apart: they cost differently from fresh input
  #add(usage: Usage): void {
    this.#inputTokens += usage.input_tokens ?? 0
    this.#cacheWriteTokens += usage.cache_creation_input_tokens ?? 0
    this.#cacheReadTokens += usage.cache_read_input_tokens ?? 0
    this.#outputTokens += usage.output_tokens ?? 0
  }

  #usage(): RunEvent {
    return { type: 'usage', inputTokens: this.#inputTokens, cacheWriteTokens: this.#cacheWriteTokens, cacheReadTokens: this.#cacheReadTokens, outputTokens: this.#outputTokens }
  }
}

function blocks(content: ContentBlock[] | string | undefined): ContentBlock[] {
  if (typeof content === 'string') return [{ type: 'text', text: content }]
  return Array.isArray(content) ? content : []
}
