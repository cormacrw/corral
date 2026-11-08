import type { Agent, DesignVersion, Run } from '@corral/contracts'
import { sameDay } from '~/utils/days'

// The tokens a run used, as the usage totals count them
export const usedTokens = (run: Pick<Run, 'inputTokens' | 'cacheWriteTokens' | 'outputTokens'>): number =>
  (run.inputTokens ?? 0) + (run.cacheWriteTokens ?? 0) + (run.outputTokens ?? 0)

export function todayStats(runs: Run[], now = Date.now()): { runs: number, tokens: number } {
  const today = runs.filter(r => sameDay(r.queuedAt, now))
  return {
    runs: today.length,
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
