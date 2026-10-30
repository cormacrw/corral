import type { Agent, Run, Task } from '@corral/contracts'
import { isLiveRun, isWorking } from './labels.ts'

export interface AgentRow {
  agent: Agent
  // The live run while working, or the latest run otherwise
  run: Run | null
}

// The mobile Agents tab (design/mobile.md): working agents first, each with
// its live run, then the rest. Runs are newest first, as the API lists them.
export function groupAgents(agents: Agent[], runs: Run[]): { working: AgentRow[], idle: AgentRow[] } {
  const working: AgentRow[] = []
  const idle: AgentRow[] = []
  for (const agent of agents) {
    const own = runs.filter(r => r.agentId === agent.id)
    if (isWorking(agent)) working.push({ agent, run: own.find(isLiveRun) ?? null })
    else idle.push({ agent, run: own[0] ?? null })
  }
  return { working, idle }
}

const sameDay = (iso: string | null, now: number) => iso !== null && new Date(iso).toDateString() === new Date(now).toDateString()

// Today's totals across every agent: runs started, PRs merged and tokens
export function todayStats(runs: Run[], tasks: Pick<Task, 'mergedAt'>[], now = Date.now()): { runs: number, merged: number, tokens: number } {
  const today = runs.filter(r => sameDay(r.queuedAt, now))
  return {
    runs: today.length,
    merged: tasks.filter(t => sameDay(t.mergedAt, now)).length,
    tokens: today.reduce((n, r) => n + (r.inputTokens ?? 0) + (r.outputTokens ?? 0), 0)
  }
}

// How much work an agent takes on at once. The PM has no concurrency, only
// one turn per Plan session (D13), so it never shows a number.
export const agentLimit = (agent: Pick<Agent, 'role' | 'concurrency'>): string =>
  agent.role === 'pm' ? 'one turn per session' : `concurrency ${agent.concurrency}`

const WHERE: Record<Agent['role'], string> = {
  developer: 'one worktree per task',
  designer: 'one worktree per task',
  reviewer: 'a read-only task worktree',
  pm: 'a read-only checkout of the default branch'
}

// The facts line on the agent detail screens, web and mobile
export function agentFacts(agent: Pick<Agent, 'role' | 'concurrency'>): string {
  const limit = agentLimit(agent)
  return `${limit[0]!.toUpperCase()}${limit.slice(1)} · ${WHERE[agent.role]} · .corral/agents/${agent.role}.md`
}
