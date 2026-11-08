import type { AuditEntry, Comment } from '@corral/contracts'
import type { AgentRole } from '@corral/core'

type Actor = Comment['author']

// The name an entry is shown under, which also finds its picture. `agent`
// names the agent that acted (runId is null for the PM an action was
// confirmed through); what's known about it differs by screen.
export function actorName(actor: Actor, agent: (role: AgentRole, runId: string | null) => string): string {
  if (actor.kind === 'human') return actor.viaPm ? agent('pm', null) : 'You'
  if (actor.kind === 'agent') return agent(actor.role, actor.runId)
  return 'Corral'
}

export const confirmedByYou = (actor: Actor) => actor.kind === 'human' && !!actor.viaPm

// One line, e.g. "Pat · confirmed by you"
export function actorLabel(actor: Actor, agent: (role: AgentRole, runId: string | null) => string): string {
  const name = actorName(actor, agent)
  return confirmedByYou(actor) ? `${name} · confirmed by you` : name
}

const words = (value: unknown) => String(value).replaceAll('_', ' ')

export function historyText(entry: AuditEntry): string {
  const d = entry.detail
  switch (entry.action) {
    case 'task.created': return 'created the task'
    case 'task.updated': return `edited ${(d.changed as string[] | undefined)?.join(', ') ?? 'the task'}`
    case 'task.revised': return `revised it with plan v${String(d.version)}`
    case 'task.claimed': return `claimed it (${words(d.from)} → ${words(d.to)})`
    case 'task.transition': return `${words(d.from)} → ${words(d.to)}${d.error ? `: ${String(d.error)}` : ''}`
    case 'run.ended': return `run #${String(d.runNumber)} ended ${String(d.state)}${d.outcome ? ` (${String(d.outcome)})` : ''}${d.error ? `: ${String(d.error)}` : ''}`
    case 'review.recorded': return `review: ${words(d.verdict)} (${String(d.met)} of ${String(d.of)} criteria met) on ${String(d.headSha).startsWith('findings-') ? 'the findings' : String(d.headSha).slice(0, 10)}`
    case 'merge.refused': return `GitHub refused the merge: ${String(d.message)}`
    case 'rebase.verified': return 'verified the trivial rebase without review'
    case 'branch.update_requested': return 'asked GitHub to update the branch from the base'
    case 'branch.head_moved': return `branch moved to ${String(d.to).slice(0, 10)}${d.approvalKept ? ' (approval kept)' : ''}`
    case 'worktrees.cleaned': return 'worktrees removed on the runner'
    case 'task.human_approved': return 'approved the merge'
    case 'design.approved': return `approved design v${String(d.version)}`
    case 'task.deleted': return 'deleted the task'
    case 'run.stopped': return 'stopped the run'
    case 'task.paused': return 'paused the task'
    case 'task.resumed': return 'resumed the task'
    default: return entry.action
  }
}
