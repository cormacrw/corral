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
  // Backlog → Ready: plan or task approved
  | { type: 'approve', content: TaskContent }
  // Ready → Backlog: sent back for rethinking
  | { type: 'send_back' }
  // Ready → In progress: the scheduler claims it
  | { type: 'claim', dependencyStatuses: readonly TaskStatus[] }
  // In progress → Agent review: a pr_opened / pr_updated outcome
  | { type: 'submit', branchAtExpectedCommit: boolean, evidenceComplete: boolean }
  // Agent review → In progress, or Blocked once the review-round cap is reached
  | { type: 'changes_requested' }
  | { type: 'ci_failed' }
  | { type: 'base_conflict' }
  // Agent review → Human review: reviewer approved and gates pass on a flagged task
  | { type: 'gates_passed', gates: MergeGateFacts }
  // Agent review or Human review → Merged: GitHub confirmed the merge.
  // `humanApprovedBy` is required when leaving Human review.
  | { type: 'merged', gates: MergeGateFacts, humanApprovedBy: string | null }
  // Human review → In progress
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
  approve: { from: ['backlog'], actors: ['human'] },
  send_back: { from: ['ready'], actors: ['human'] },
  claim: { from: ['ready'], actors: ['scheduler'] },
  submit: { from: ['in_progress'], actors: ['server'] },
  changes_requested: { from: ['agent_review'], actors: ['server'] },
  ci_failed: { from: ['agent_review'], actors: ['server'] },
  base_conflict: { from: ['agent_review'], actors: ['server'] },
  gates_passed: { from: ['agent_review'], actors: ['server'] },
  merged: { from: ['agent_review', 'human_review'], actors: ['server'] },
  human_request_changes: { from: ['human_review'], actors: ['human'] },
  block: { from: ['ready', 'in_progress', 'agent_review', 'human_review'], actors: ['server'] },
  fail: { from: ['in_progress', 'agent_review'], actors: ['server'] },
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
  | { code: 'not_flagged_for_human_review' }
  | { code: 'human_review_required' }
  | { code: 'human_approval_missing' }
  | { code: 'reason_required' }

export type TransitionResult =
  | { ok: true, task: TaskState }
  | { ok: false, error: TransitionError }

// New tasks start in Backlog, proposed by the PM or created by the human
export function createTask(actor: Actor, humanReview: boolean): TransitionResult {
  const type = actorType(actor)
  if (type !== 'human' && type !== 'pm') {
    return fail({ code: 'actor_not_allowed', actor: type, event: 'approve' })
  }
  return ok({ status: 'backlog', humanReview, reviewRounds: 0, failedRuns: 0, reason: null })
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

    case 'gates_passed': {
      if (!task.humanReview) return fail({ code: 'not_flagged_for_human_review' })
      const gates = failedMergeGates(event.gates)
      if (gates.length > 0) return fail({ code: 'gates_failed', gates })
      return ok({ ...task, status: 'human_review' })
    }

    case 'merged': {
      if (task.status === 'agent_review' && task.humanReview) {
        return fail({ code: 'human_review_required' })
      }
      if (task.status === 'human_review' && !event.humanApprovedBy) {
        return fail({ code: 'human_approval_missing' })
      }
      const gates = failedMergeGates(event.gates)
      if (gates.length > 0) return fail({ code: 'gates_failed', gates })
      return ok({ ...task, status: 'merged' })
    }

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
