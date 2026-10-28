import { actorType, type Actor, type ActorType } from './actor.ts'
import { failedMergeGates, type MergeGate, type MergeGateFacts } from './merge-gates.ts'
import { checkDefinitionOfReady, type ReadyProblem, type TaskContent } from './ready.ts'
import type { TaskStatus } from './status.ts'

// The task state machine (D10). Every status change in Corral goes through
// `transition`; the server enforces it and rejects anything not listed here.

export interface TaskState {
  status: TaskStatus
  // D5: flagged tasks wait in Human review instead of auto-merging
  humanReview: boolean
  // Agent review rounds that ended in changes requested, since the task was
  // last unblocked
  reviewRounds: number
  // Failed runs since the task was last un-failed. Rate-limited, stopped and
  // interrupted runs don't count (D3, D10).
  failedRuns: number
  // Why the task is Blocked or Failed; shown in the Inbox (D11)
  reason: string | null
}

export interface TaskLimits {
  reviewRoundCap: number
  failedRunCap: number
}

// PRD §7.8 defaults
export const DEFAULT_LIMITS: TaskLimits = { reviewRoundCap: 5, failedRunCap: 3 }

// Each event carries the facts its guard needs, so this module stays pure.
// The server gathers them from the database and GitHub.
export type TaskEvent =
  // Draft or Backlog → Ready: plan or task approved onto the board
  | { type: 'approve', content: TaskContent }
  // Draft → Backlog: the human keeps a proposed task for later or for refining
  | { type: 'accept' }
  // Ready → Backlog: sent back for rethinking
  | { type: 'send_back' }
  // Ready → In progress: the scheduler claims it
  | { type: 'claim', dependencyStatuses: readonly TaskStatus[] }
  // In progress → Agent review: a pr_opened / pr_updated outcome
  | { type: 'submit', branchAtExpectedCommit: boolean, evidenceComplete: boolean }
  // Agent review → In progress, or Blocked once the review-round cap is reached
  | { type: 'changes_requested' }
  // Agent review → Human review for a flagged task, otherwise Ready to merge
  | { type: 'review_approved' }
  // Human review → Ready to merge
  | { type: 'human_approve' }
  // Ready to merge → In progress: CI failed or the branch conflicts with the base
  | { type: 'ci_failed' }
  | { type: 'base_conflict' }
  // Ready to merge → Agent review: a new commit (not a base update) needs a fresh review
  | { type: 'head_moved' }
  // Ready to merge → Merged: Corral merged and GitHub confirmed it
  | { type: 'merged', gates: MergeGateFacts }
  // → Merged: GitHub shows the PR merged outside Corral. A fact, not a request.
  | { type: 'merged_outside' }
  // Human review or Ready to merge → In progress
  | { type: 'human_request_changes' }
  | { type: 'block', reason: string }
  | { type: 'fail', reason: string }
  // A run ended Failed. Keeps the status for a retry, or → Failed at the cap.
  | { type: 'run_failed' }
  // Blocked or Failed → Backlog, Ready or In progress (In progress keeps the branch and PR)
  | { type: 'resolve', to: 'backlog' | 'ready' | 'in_progress' }

export type TaskEventType = TaskEvent['type']

interface Rule {
  from: readonly TaskStatus[]
  actors: readonly ActorType[]
}

export const TRANSITION_RULES: Readonly<Record<TaskEventType, Rule>> = {
  approve: { from: ['draft', 'backlog'], actors: ['human'] },
  accept: { from: ['draft'], actors: ['human'] },
  send_back: { from: ['ready'], actors: ['human'] },
  claim: { from: ['ready'], actors: ['scheduler'] },
  submit: { from: ['in_progress'], actors: ['server'] },
  changes_requested: { from: ['agent_review'], actors: ['server'] },
  review_approved: { from: ['agent_review'], actors: ['server'] },
  human_approve: { from: ['human_review'], actors: ['human'] },
  ci_failed: { from: ['ready_to_merge'], actors: ['server'] },
  base_conflict: { from: ['ready_to_merge'], actors: ['server'] },
  head_moved: { from: ['ready_to_merge'], actors: ['server'] },
  merged: { from: ['ready_to_merge'], actors: ['server'] },
  merged_outside: { from: ['agent_review', 'human_review', 'ready_to_merge'], actors: ['server'] },
  human_request_changes: { from: ['human_review', 'ready_to_merge'], actors: ['human'] },
  block: { from: ['ready', 'in_progress', 'agent_review', 'human_review', 'ready_to_merge'], actors: ['server'] },
  fail: { from: ['in_progress', 'agent_review', 'ready_to_merge'], actors: ['server'] },
  run_failed: { from: ['in_progress', 'agent_review'], actors: ['server'] },
  resolve: { from: ['blocked', 'failed'], actors: ['human'] }
}

export type TransitionError =
  | { code: 'invalid_transition', status: TaskStatus, event: TaskEventType }
  | { code: 'actor_not_allowed', actor: ActorType | null, event: TaskEventType }
  | { code: 'not_ready', problems: ReadyProblem[] }
  | { code: 'dependencies_not_merged' }
  | { code: 'invalid_outcome', problems: ('branch_not_at_expected_commit' | 'evidence_incomplete')[] }
  | { code: 'gates_failed', gates: MergeGate[] }
  | { code: 'reason_required' }

export type TransitionResult =
  | { ok: true, task: TaskState }
  | { ok: false, error: TransitionError }

// The human's tasks start in Backlog. The PM's plan tasks start as Drafts,
// seen only in the plan until the human sends them to the board or the
// Backlog; its other tasks (documentation fixes) start in Backlog.
export function createTask(actor: Actor, humanReview: boolean, draft = false): TransitionResult {
  const type = actorType(actor)
  if (type !== 'human' && type !== 'pm') {
    return fail({ code: 'actor_not_allowed', actor: type, event: 'approve' })
  }
  return ok({ status: draft && type === 'pm' ? 'draft' : 'backlog', humanReview, reviewRounds: 0, failedRuns: 0, reason: null })
}

export function transition(
  task: TaskState,
  event: TaskEvent,
  actor: Actor,
  limits: TaskLimits = DEFAULT_LIMITS
): TransitionResult {
  const rule = TRANSITION_RULES[event.type]
  if (!rule.from.includes(task.status)) {
    return fail({ code: 'invalid_transition', status: task.status, event: event.type })
  }
  const type = actorType(actor)
  if (type === null || !rule.actors.includes(type)) {
    return fail({ code: 'actor_not_allowed', actor: type, event: event.type })
  }

  switch (event.type) {
    case 'approve': {
      const problems = checkDefinitionOfReady(event.content)
      if (problems.length > 0) return fail({ code: 'not_ready', problems })
      return ok({ ...task, status: 'ready' })
    }

    case 'send_back':
    case 'accept':
      return ok({ ...task, status: 'backlog' })

    case 'claim':
      // D10: Ready tasks may have unmerged dependencies; they just aren't claimed yet
      if (event.dependencyStatuses.some(s => s !== 'merged')) {
        return fail({ code: 'dependencies_not_merged' })
      }
      return ok({ ...task, status: 'in_progress' })

    case 'submit': {
      const problems: ('branch_not_at_expected_commit' | 'evidence_incomplete')[] = []
      if (!event.branchAtExpectedCommit) problems.push('branch_not_at_expected_commit')
      if (!event.evidenceComplete) problems.push('evidence_incomplete')
      if (problems.length > 0) return fail({ code: 'invalid_outcome', problems })
      return ok({ ...task, status: 'agent_review' })
    }

    case 'changes_requested': {
      const reviewRounds = task.reviewRounds + 1
      // Another round would go past the cap (flows.md step 7a)
      if (reviewRounds >= limits.reviewRoundCap) {
        return ok({ ...task, reviewRounds, status: 'blocked', reason: `Review-round cap reached (${limits.reviewRoundCap})` })
      }
      return ok({ ...task, reviewRounds, status: 'in_progress' })
    }

    case 'ci_failed':
    case 'base_conflict':
    case 'human_request_changes':
      return ok({ ...task, status: 'in_progress' })

    // D5: only the task's own flag sends it to a human
    case 'review_approved':
      return ok({ ...task, status: task.humanReview ? 'human_review' : 'ready_to_merge' })

    case 'human_approve':
      return ok({ ...task, status: 'ready_to_merge' })

    case 'head_moved':
      return ok({ ...task, status: 'agent_review' })

    case 'merged': {
      const gates = failedMergeGates(event.gates)
      if (gates.length > 0) return fail({ code: 'gates_failed', gates })
      return ok({ ...task, status: 'merged' })
    }

    case 'merged_outside':
      return ok({ ...task, status: 'merged', reason: null })

    case 'block':
    case 'fail': {
      const reason = event.reason.trim()
      if (!reason) return fail({ code: 'reason_required' })
      return ok({ ...task, status: event.type === 'block' ? 'blocked' : 'failed', reason })
    }

    case 'run_failed': {
      const failedRuns = task.failedRuns + 1
      if (failedRuns >= limits.failedRunCap) {
        return ok({ ...task, failedRuns, status: 'failed', reason: `Failed-run cap reached (${limits.failedRunCap})` })
      }
      return ok({ ...task, failedRuns })
    }

    case 'resolve':
      // D10: resolving Failed resets the failed-run counter; resolving
      // Blocked resets the review-round counter
      return ok({
        ...task,
        status: event.to,
        reason: null,
        failedRuns: task.status === 'failed' ? 0 : task.failedRuns,
        reviewRounds: task.status === 'blocked' ? 0 : task.reviewRounds
      })
  }
}

// The events this actor may attempt on this task right now. Guards can still
// reject them; this is for showing or hiding actions in the UI.
export function availableEvents(task: TaskState, actor: Actor): TaskEventType[] {
  const type = actorType(actor)
  if (type === null) return []
  return (Object.keys(TRANSITION_RULES) as TaskEventType[]).filter((event) => {
    const rule = TRANSITION_RULES[event]
    return rule.from.includes(task.status) && rule.actors.includes(type)
  })
}

function ok(task: TaskState): TransitionResult {
  return { ok: true, task }
}

function fail(error: TransitionError): TransitionResult {
  return { ok: false, error }
}
