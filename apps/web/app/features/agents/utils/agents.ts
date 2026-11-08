import type { Agent, DesignVersion, Run, Task } from '@corral/contracts'
import { isLiveRun, isWorking } from '~/utils/labels.ts'

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

export const sameDay = (iso: string | null, now: number) => iso !== null && new Date(iso).toDateString() === new Date(now).toDateString()

// The tokens a run used, as the usage totals count them
export const usedTokens = (run: Pick<Run, 'inputTokens' | 'cacheWriteTokens' | 'outputTokens'>): number =>
  (run.inputTokens ?? 0) + (run.cacheWriteTokens ?? 0) + (run.outputTokens ?? 0)

// Today's totals across every agent: runs started, PRs merged and tokens
export function todayStats(runs: Run[], tasks: Pick<Task, 'mergedAt'>[], now = Date.now()): { runs: number, merged: number, tokens: number } {
  const today = runs.filter(r => sameDay(r.queuedAt, now))
  return {
    runs: today.length,
    merged: tasks.filter(t => sameDay(t.mergedAt, now)).length,
    tokens: today.reduce((n, r) => n + usedTokens(r), 0)
  }
}

// How much work an agent takes on at once. The PM has no concurrency, only
// one turn per Plan session (D13), so it never shows a number.
export const agentLimit = (agent: Pick<Agent, 'role' | 'concurrency'>): string =>
  agent.role === 'pm' ? 'one turn per session' : `concurrency ${agent.concurrency}`

const WHERE: Record<Agent['role'], string> = {
  developer: 'one worktree per task',
  designer: 'one task worktree on design/<ref>',
  reviewer: 'a read-only task worktree',
  pm: 'a read-only checkout of the default branch'
}

// The facts line on the agent detail screens, web and mobile
export function agentFacts(agent: Pick<Agent, 'role' | 'concurrency'>): string {
  const limit = agentLimit(agent)
  return `${limit[0]!.toUpperCase()}${limit.slice(1)} · ${WHERE[agent.role]} · .corral/agents/${agent.role}.md`
}

// What an agent's page says with no run to show
export const agentIdleNote = (agent: Pick<Agent, 'name' | 'role'>): string => agent.role === 'pm'
  ? `${agent.name} isn't running. ${agent.name} only runs when you send a message in Plan.`
  : `${agent.name} is idle.`

// Match immutable version commits to authoring runs, so another designer's
// work and reviewer approvals never inflate this agent's totals. A superseded
// approved version retains its Plan session, recording the human approval.
export function designerStats(runs: Run[], designs: { taskId: string, versions: DesignVersion[] }[]): { submitted: number, approved: number } {
  let submitted = 0
  let approved = 0
  for (const design of designs) {
    const commits = new Set(runs.filter(r => r.role === 'designer' && r.taskId === design.taskId && r.headSha).map(r => r.headSha))
    const own = design.versions.filter(v => commits.has(v.commitSha))
    submitted += own.length
    if (own.some(v => v.status === 'approved' || v.planSessionId !== null)) approved++
  }
  return { submitted, approved }
}

// The icon beside each of an agent page's stat tiles, by its label
export function tileIcon(label: string): string {
  if (/^(Runs|Reviews|Turns) this week$/.test(label)) return 'i-hugeicons-play'
  if (label.startsWith('Avg')) return 'i-hugeicons-clock-01'
  if (label === 'Usage today') return 'i-hugeicons-coins-01'
  if (label === 'PRs opened') return 'i-hugeicons-git-pull-request'
  if (label === 'Stuck') return 'i-hugeicons-alert-02'
  if (label === 'Changes requested') return 'i-hugeicons-pencil-edit-02'
  if (label === 'Design versions submitted') return 'i-hugeicons-task-01'
  return 'i-hugeicons-checkmark-circle-02'
}
