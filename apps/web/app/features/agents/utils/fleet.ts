import type { Agent, Run } from '@corral/contracts'
import type { AgentRole } from '@corral/core'
import { startOfDay } from '~/features/home/utils/overview.ts'
import { isLiveRun } from '~/utils/labels.ts'
import { usedTokens } from './agents.ts'

// The Agents page's figures (design/agent.md, Agents): runs, tokens and busy
// time, from the history the page loads with `GET /api/runs?since=`.

const HOUR = 3_600_000
const DAY = 24 * HOUR

// What a run's bar on the timeline says about it. Rate limits and
// interruptions aren't failures (D3), so they're quiet rather than red.
export type RunTone = 'live' | 'done' | 'changes' | 'failed' | 'quiet'
export const RUN_TONE: Record<RunTone, { label: string, color: string }> = {
  live: { label: 'Live', color: 'var(--series-1)' },
  done: { label: 'Finished', color: 'var(--chart-3)' },
  changes: { label: 'Changes requested', color: 'var(--warning)' },
  failed: { label: 'Failed or stuck', color: 'var(--destructive)' },
  quiet: { label: 'Interrupted or rate limited', color: 'var(--muted-foreground)' }
}
export function runTone(run: Pick<Run, 'state' | 'outcome'>): RunTone {
  if (isLiveRun(run)) return 'live'
  if (run.outcome === 'changes_requested') return 'changes'
  if (run.outcome === 'failed' || run.outcome === 'stuck' || run.outcome === 'blocked' || run.state === 'failed') return 'failed'
  // A PM turn completes with no outcome to report; only a stopped run is quiet
  if ((run.outcome === null && run.state !== 'completed') || run.outcome === 'rate_limited') return 'quiet'
  return 'done'
}

// When a run occupied its agent: from start to end, or to now while live.
// Runs that never started took no time.
function span(run: Pick<Run, 'startedAt' | 'endedAt'>, now: number): [number, number] | null {
  if (!run.startedAt) return null
  return [Date.parse(run.startedAt), run.endedAt ? Date.parse(run.endedAt) : now]
}

// Bars for the last `hours` hours, clipped to the window: x is hours since
// the window opened, so now is at the right edge
export interface RunBar { run: Run, lane: string, x: number, hours: number, tone: RunTone }
export function runBars(runs: Run[], agents: Pick<Agent, 'id' | 'name'>[], hours: number, now: number): RunBar[] {
  const from = now - hours * HOUR
  const order = new Map(agents.map((a, i) => [a.id, i]))
  return runs
    .flatMap((run) => {
      const at = span(run, now)
      if (!at || at[1] < from) return []
      const start = Math.max(at[0], from)
      return [{ run, lane: run.agentName, x: (start - from) / HOUR, hours: Math.max(0, at[1] - start) / HOUR, tone: runTone(run) }]
    })
    // Lanes in the shell's agent order; the timeline groups bars by lane
    .sort((a, b) => (order.get(a.run.agentId) ?? Infinity) - (order.get(b.run.agentId) ?? Infinity) || a.x - b.x)
}

// Tokens per local day by role, for the last `days` days, today last
export const TOKEN_ROLES = ['developer', 'reviewer', 'pm', 'designer'] as const satisfies readonly AgentRole[]
export interface TokenDay { date: Date, index: number, byRole: Record<AgentRole, number> }
export function tokensByDay(runs: Pick<Run, 'role' | 'queuedAt' | 'inputTokens' | 'cacheWriteTokens' | 'outputTokens'>[], days: number, now: number): TokenDay[] {
  const first = startOfDay(now) - (days - 1) * DAY
  const rows: TokenDay[] = Array.from({ length: days }, (_, index) => ({
    date: new Date(first + index * DAY),
    index,
    byRole: { developer: 0, reviewer: 0, pm: 0, designer: 0 }
  }))
  for (const run of runs) {
    const row = rows[Math.round((startOfDay(Date.parse(run.queuedAt)) - first) / DAY)]
    if (row) row.byRole[run.role] += usedTokens(run)
  }
  return rows
}

// The share of the last `hours` hours an agent spent running, out of what its
// concurrency allows. Overlapping runs count once per slot they fill.
export function busyShare(runs: Run[], agent: Pick<Agent, 'id' | 'role' | 'concurrency'>, hours: number, now: number): number {
  const from = now - hours * HOUR
  const busy = runs
    .filter(run => run.agentId === agent.id)
    .reduce((total, run) => {
      const at = span(run, now)
      return at ? total + Math.max(0, Math.min(at[1], now) - Math.max(at[0], from)) : total
    }, 0)
  // The PM takes one turn per Plan session (D13), so its slots aren't fixed
  const slots = agent.role === 'pm' ? 1 : Math.max(1, agent.concurrency)
  return Math.min(1, busy / (hours * HOUR * slots))
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000) return `${Math.round(n / 1000)}k`
  return String(n)
}

// One agent's page (design/agent.md): its runs over the last `days` days,
// one lane per local day that has runs (today first), x the hour of day
// 0–24. A day with no runs gets no lane. A run over midnight is clipped at
// the end of the day it started.
const LANE_DAY = new Intl.DateTimeFormat(undefined, { day: 'numeric', weekday: 'short' })
export function dayLane(index: number, date: Date): string {
  if (index === 0) return 'Today'
  if (index === 1) return 'Yesterday'
  const parts = LANE_DAY.formatToParts(date)
  return `${parts.find(p => p.type === 'day')?.value} ${parts.find(p => p.type === 'weekday')?.value}`
}
export function dayBars(runs: Run[], days: number, now: number): RunBar[] {
  const today = startOfDay(now)
  return runs
    .flatMap((run) => {
      const at = span(run, now)
      if (!at) return []
      const day = startOfDay(at[0])
      const index = Math.round((today - day) / DAY)
      if (index < 0 || index >= days) return []
      const end = Math.min(at[1], day + DAY)
      return [{ bar: { run, lane: dayLane(index, new Date(day)), x: (at[0] - day) / HOUR, hours: Math.max(0, end - at[0]) / HOUR, tone: runTone(run) }, index }]
    })
    .sort((a, b) => a.index - b.index || a.bar.x - b.bar.x)
    .map(({ bar }) => bar)
}

// Ended runs per local day by how they ended, oldest first, for the
// Outcomes chart. Live runs haven't ended, so they're left out.
export type EndTone = Exclude<RunTone, 'live'>
export const END_TONES = ['done', 'changes', 'failed', 'quiet'] as const satisfies readonly EndTone[]
export interface OutcomeDay { date: Date, index: number, byTone: Record<EndTone, number>, total: number }
export function outcomesByDay(runs: Pick<Run, 'state' | 'outcome' | 'queuedAt'>[], days: number, now: number): OutcomeDay[] {
  const first = startOfDay(now) - (days - 1) * DAY
  const rows: OutcomeDay[] = Array.from({ length: days }, (_, index) => ({ date: new Date(first + index * DAY), index, byTone: { done: 0, changes: 0, failed: 0, quiet: 0 }, total: 0 }))
  for (const run of runs) {
    const tone = runTone(run)
    if (tone === 'live') continue
    const row = rows[Math.round((startOfDay(Date.parse(run.queuedAt)) - first) / DAY)]
    if (!row) continue
    row.byTone[tone] += 1
    row.total += 1
  }
  return rows
}

// The median minutes of the runs that started and ended, per local day,
// oldest first; null for a day with none (a gap, never a zero)
export function medianMinutesByDay(runs: Pick<Run, 'queuedAt' | 'startedAt' | 'endedAt'>[], days: number, now: number): (number | null)[] {
  const first = startOfDay(now) - (days - 1) * DAY
  const byDay: number[][] = Array.from({ length: days }, () => [])
  for (const run of runs) {
    if (!run.startedAt || !run.endedAt) continue
    byDay[Math.round((startOfDay(Date.parse(run.queuedAt)) - first) / DAY)]?.push((Date.parse(run.endedAt) - Date.parse(run.startedAt)) / 60_000)
  }
  return byDay.map((minutes) => {
    if (!minutes.length) return null
    const sorted = minutes.sort((a, b) => a - b)
    const mid = Math.floor(sorted.length / 2)
    return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2
  })
}
