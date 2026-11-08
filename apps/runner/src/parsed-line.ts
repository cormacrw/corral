import type { RunEvent } from '@corral/contracts'

// What every adapter's parser turns one line of its CLI's output into: Corral's
// runtime-neutral RunEvents (agent-runtime-and-auth.md rule 7), plus what the
// run manager needs to know about the session and its end.

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
  // An empty result that took no model turn and isn't a CLI command's answer.
  // A resumed session prints one for the background commands its last process
  // left behind, ahead of the new prompt
  emptyTurn?: boolean
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
