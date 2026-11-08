import type { Agent, Run } from '@corral/contracts'
import type { AgentRole } from '@corral/core'
import { dayRows } from '~/utils/days'
import { isActiveRun } from '@corral/core'
import { usedTokens } from './agents.ts'

// The Agents page's figures (design/agent.md, Agents): runs, tokens and busy
// time, from the history the page loads with `GET /api/runs?since=`.

const HOUR = 3_600_000

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
  if (isActiveRun(run.state)) return 'live'
  if (run.outcome === 'changes_requested') return 'changes'
  if (run.outcome === 'failed' || run.outcome === 'stuck' || run.outcome === 'blocked' || run.state === 'failed') return 'failed'
  if (run.outcome === null || run.outcome === 'rate_limited') return 'quiet'
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
  const { rows, rowAt } = dayRows<TokenDay>(days, now, (date, index) => ({ date, index, byRole: { developer: 0, reviewer: 0, pm: 0, designer: 0 } }))
  for (const run of runs) {
    const row = rowAt(run.queuedAt)
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
