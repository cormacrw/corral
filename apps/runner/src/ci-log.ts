import { stripAnsi } from '@corral/contracts'

// Reads a CI log as it arrives, so one too long to hold (tens of megabytes is
// normal) still gives both of the things worth keeping: its end, and the
// failure lines that turbo printed long before its end.

// Reserve room for verdicts, their context, and other markers independently.
// Failed package sections cover errors that match none of those patterns.
const MAX_FAIL_CHARS = 1200
const MAX_CONTEXT_CHARS = 1200
const MAX_OTHER_CHARS = 600
const MAX_SECTION_CHARS = 3000
const MAX_LINE_CHARS = 300
const MAX_SECTIONS = 256
const MAX_PARTIAL_CHARS = 4096
// What a test runner prints under a FAIL line: the assertion and its diff
const CONTEXT_LINES = 8

const TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/
// `@corral/web:test: ` when turbo prefixes lines rather than grouping them
const TURBO_PREFIX = /^([^\s:]+:[^\s:]+): ?/
const BARE_PACKAGE = /^([^\s:]+:[^\s:]+)$/
const LIFECYCLE = /^\s*\[?ELIFECYCLE\b/
const GROUP = /^##\[group\](.+)$/
const FAILED_PACKAGE = /^\s*Failed:\s+(\S+#\S+)\s*$/
// Case matters: `FAIL` is vitest's and jest's verdict, `fail` is any old word
const FAILURE = /^\s*(?:FAIL\s|[×✗✖]\s|##\[error\]|ERROR\b|ELIFECYCLE\b|\S+\(\d+,\d+\): error |\d+:\d+\s+error\s)|\berror TS\d+:/
const PASSED = /^\s*[✓✔]\s/

export function logLine(raw: string): string {
  return stripAnsi(raw).replace(/\r$/, '').replace(TIMESTAMP, '')
}

export class CiLogScanner {
  #tailChars: number
  #tail = ''
  #partial = ''
  #matched: string[] = []
  #fail: string[] = []
  #failChars = 0
  #contextChars = 0
  #matchedChars = 0
  #context = 0
  #group: string | null = null
  #sections = new Map<string, string>()
  #beforeExit = new Map<string, string>()
  #failed = new Set<string>()

  constructor(tailChars: number) {
    this.#tailChars = tailChars
  }

  write(chunk: string): void {
    this.#tail = (this.#tail + chunk).slice(-this.#tailChars)
    const lines = (this.#partial + chunk).split('\n')
    // Only a line's start is ever kept, however long it runs without ending
    this.#partial = lines.pop()!.slice(0, MAX_PARTIAL_CHARS)
    for (const line of lines) this.#line(logLine(line))
  }

  finish(): { tail: string, failureLines: string[] } {
    if (this.#partial) this.#line(logLine(this.#partial))
    this.#partial = ''
    return { tail: this.#tail, failureLines: [...this.#fail, ...this.#matched, ...this.#failedSections()] }
  }

  #line(line: string): void {
    const failed = FAILED_PACKAGE.exec(line)?.[1]
    if (failed) this.#failed.add(failed.replace('#', ':'))
    this.#section(line)
    const body = line.replace(TURBO_PREFIX, '')
    if (FAILURE.test(body) || failed) {
      const verdict = /^\s*FAIL\s/.test(body)
      this.#context = verdict ? CONTEXT_LINES : 0
      this.#keep(line, verdict)
    } else if (body.startsWith('##[')) {
      this.#context = 0
    } else if (this.#context > 0) {
      this.#context--
      if (body.trim() && !PASSED.test(body)) this.#keep(line, true, true)
    }
  }

  // The first failures are kept over the last: the rest usually follow from them
  #keep(line: string, verdict = false, context = false): void {
    const text = line.slice(0, MAX_LINE_CHARS)
    if (verdict) {
      const used = context ? this.#contextChars : this.#failChars
      if (used + text.length + 1 > (context ? MAX_CONTEXT_CHARS : MAX_FAIL_CHARS)) return
      this.#fail.push(text)
      if (context) this.#contextChars += text.length + 1
      else this.#failChars += text.length + 1
      return
    }
    if (this.#matchedChars + text.length + 1 > MAX_OTHER_CHARS) return
    this.#matched.push(text)
    this.#matchedChars += text.length + 1
  }

  #section(line: string): void {
    const group = GROUP.exec(line)?.[1]
    if (group) this.#group = group.trim().replace('#', ':')
    else if (line.startsWith('##[endgroup]')) this.#group = null
    else if (!this.#group) this.#group = BARE_PACKAGE.exec(line)?.[1] ?? null
    const key = TURBO_PREFIX.exec(line)?.[1] ?? this.#group
    if (!key || group || PASSED.test(line.replace(TURBO_PREFIX, ''))) return
    if (!this.#sections.has(key) && this.#sections.size >= MAX_SECTIONS) return
    // A failing package can print this twice, hundreds of thousands of lines
    // apart. The last is its true exit, with the error somewhere above it.
    if (LIFECYCLE.test(line.replace(TURBO_PREFIX, ''))) this.#beforeExit.set(key, this.#sections.get(key) ?? '')
    const text = `${this.#sections.get(key) ?? ''}${line.slice(0, MAX_LINE_CHARS)}\n`
    this.#sections.set(key, text.slice(-MAX_SECTION_CHARS))
  }

  #failedSections(): string[] {
    const kept = new Set([...this.#fail, ...this.#matched])
    return [...this.#failed].flatMap((key) => {
      const end = this.#sections.get(key)
      if (!end) return []
      // Whatever came after the exit gets half a window more. They overlap
      // when the exit ends the section, which still leaves the full window.
      const before = this.#beforeExit.get(key)
      const windows = before ? [[before, MAX_SECTION_CHARS], [end.slice(-MAX_SECTION_CHARS / 2), MAX_SECTION_CHARS / 2]] as const : [[end, MAX_SECTION_CHARS]] as const
      return windows.flatMap(([text, limit]) => text.split('\n').slice(text.length < limit ? 0 : 1).filter((line) => {
        if (!line.trim() || kept.has(line)) return false
        kept.add(line)
        return true
      }))
    })
  }
}
