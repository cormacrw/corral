// Reads a CI log as it arrives, so one too long to hold (tens of megabytes is
// normal) still gives both of the things worth keeping: its end, and the
// failure lines that turbo printed long before its end.

// Two runs of a bound: lines that look like failures, then the end of each
// package `Failed:` names, whose assertion may match nothing
const MAX_MATCHED_CHARS = 3000
const MAX_SECTION_CHARS = 3000
const MAX_LINE_CHARS = 300
const MAX_SECTIONS = 256
const MAX_PARTIAL_CHARS = 4096
// What a test runner prints under a FAIL line: the assertion and its diff
const CONTEXT_LINES = 8

// eslint-disable-next-line no-control-regex -- terminal colours are what this removes
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g
const TIMESTAMP = /^\d{4}-\d\d-\d\dT[\d:.]+Z ?/
// `@corral/web:test: ` when turbo prefixes lines rather than grouping them
const TURBO_PREFIX = /^([^\s:]+:[^\s:]+): ?/
const GROUP = /^##\[group\](.+)$/
const FAILED_PACKAGE = /^\s*Failed:\s+(\S+#\S+)\s*$/
// Case matters: `FAIL` is vitest's and jest's verdict, `fail` is any old word
const FAILURE = /^\s*(?:FAIL\s|[×✗✖]\s|##\[error\]|ERROR\b|ELIFECYCLE\b|\S+\(\d+,\d+\): error |\d+:\d+\s+error\s)|\berror TS\d+:/
const PASSED = /^\s*[✓✔]\s/

export function logLine(raw: string): string {
  return raw.replace(ANSI, '').replace(/\r$/, '').replace(TIMESTAMP, '')
}

export class CiLogScanner {
  #tailChars: number
  #tail = ''
  #partial = ''
  #matched: string[] = []
  #matchedChars = 0
  #context = 0
  #group: string | null = null
  #sections = new Map<string, string>()
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
    return { tail: this.#tail, failureLines: [...this.#matched, ...this.#failedSections()] }
  }

  #line(line: string): void {
    const failed = FAILED_PACKAGE.exec(line)?.[1]
    if (failed) this.#failed.add(failed.replace('#', ':'))
    this.#section(line)
    const body = line.replace(TURBO_PREFIX, '')
    if (FAILURE.test(body) || failed) {
      this.#context = /^\s*(?:FAIL|[×✗✖])\s/.test(body) ? CONTEXT_LINES : 0
      this.#keep(line)
    } else if (body.startsWith('##[')) {
      this.#context = 0
    } else if (this.#context > 0) {
      this.#context--
      if (body.trim()) this.#keep(line)
    }
  }

  // The first failures are kept over the last: the rest usually follow from them
  #keep(line: string): void {
    const text = line.slice(0, MAX_LINE_CHARS)
    if (this.#matchedChars + text.length > MAX_MATCHED_CHARS) return
    this.#matched.push(text)
    this.#matchedChars += text.length + 1
  }

  #section(line: string): void {
    const group = GROUP.exec(line)?.[1]
    if (group) this.#group = group.trim().replace('#', ':')
    else if (line.startsWith('##[endgroup]')) this.#group = null
    const key = TURBO_PREFIX.exec(line)?.[1] ?? this.#group
    if (!key || group || PASSED.test(line.replace(TURBO_PREFIX, ''))) return
    if (!this.#sections.has(key) && this.#sections.size >= MAX_SECTIONS) return
    const text = `${this.#sections.get(key) ?? ''}${line.slice(0, MAX_LINE_CHARS)}\n`
    this.#sections.set(key, text.slice(-MAX_SECTION_CHARS))
  }

  #failedSections(): string[] {
    const kept = new Set(this.#matched)
    return [...this.#failed].flatMap((key) => {
      const text = this.#sections.get(key)
      if (!text) return []
      const whole = text.length < MAX_SECTION_CHARS
      return text.split('\n').slice(whole ? 0 : 1).filter(line => line.trim() && !kept.has(line))
    })
  }
}
