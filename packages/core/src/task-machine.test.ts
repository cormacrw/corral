import { describe, expect, it } from 'vitest'
import type { Actor } from './actor.ts'
import type { MergeGateFacts } from './merge-gates.ts'
import { TASK_STATUSES, type TaskStatus } from './status.ts'
import {
  availableEvents,
  createTask,
  transition,
  type TaskEvent,
  type TaskEventType,
  type TaskState
} from './task-machine.ts'

const human: Actor = { kind: 'human', userId: 'u1' }
const pm: Actor = { kind: 'agent', role: 'pm', runId: 'r1' }
const developer: Actor = { kind: 'agent', role: 'developer', runId: 'r2' }
const scheduler: Actor = { kind: 'system', component: 'scheduler' }
const server: Actor = { kind: 'system', component: 'server' }

const passingGates: MergeGateFacts = {
  approvalIsForHeadCommit: true,
  requiredChecksPassed: true,
  evidenceComplete: true,
  mergeable: true
}

const content = { title: 'Add login', description: 'Email + password', acceptanceCriteria: ['Shows an error on a bad password'] }

// One valid example of every event, with facts that pass its guard
const validEvents: Record<TaskEventType, TaskEvent> = {
  approve: { type: 'approve', content },
  send_back: { type: 'send_back' },
  claim: { type: 'claim', dependencyStatuses: ['merged'] },
  submit: { type: 'submit', branchAtExpectedCommit: true, evidenceComplete: true },
  changes_requested: { type: 'changes_requested' },
  ci_failed: { type: 'ci_failed' },
  base_conflict: { type: 'base_conflict' },
  gates_passed: { type: 'gates_passed', gates: passingGates },
  merged: { type: 'merged', gates: passingGates, humanApprovedBy: 'u1' },
  human_request_changes: { type: 'human_request_changes' },
  block: { type: 'block', reason: 'Requirements contradict each other' },
  fail: { type: 'fail', reason: 'Repository not accessible' },
  run_failed: { type: 'run_failed' },
  resolve: { type: 'resolve', to: 'ready' }
}

// The D10 transition table, written out independently of TRANSITION_RULES:
// event → [allowed from-statuses, actor that may trigger it]
const d10: Record<TaskEventType, [TaskStatus[], Actor]> = {
  approve: [['backlog'], human],
  send_back: [['ready'], human],
  claim: [['ready'], scheduler],
  submit: [['in_progress'], server],
  changes_requested: [['agent_review'], server],
  ci_failed: [['agent_review'], server],
  base_conflict: [['agent_review'], server],
  gates_passed: [['agent_review'], server],
  merged: [['agent_review', 'human_review'], server],
  human_request_changes: [['human_review'], human],
  block: [['ready', 'in_progress', 'agent_review', 'human_review'], server],
  fail: [['in_progress', 'agent_review'], server],
  run_failed: [['in_progress', 'agent_review'], server],
  resolve: [['blocked', 'failed'], human]
}

// Table rows whose guard needs more than the default state
const stateFor: Partial<Record<TaskEventType, Partial<TaskState>>> = {
  gates_passed: { humanReview: true }
}

function task(status: TaskStatus, overrides: Partial<TaskState> = {}): TaskState {
  // Flagged tasks are the only ones that may reach Human review
  return { status, humanReview: status === 'human_review', reviewRounds: 0, failedRuns: 0, reason: null, ...overrides }
}

function expectOk(result: ReturnType<typeof transition>): TaskState {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`)
  return result.task
}

describe('the D10 transition table', () => {
  const events = Object.keys(d10) as TaskEventType[]

  for (const event of events) {
    const [from, actor] = d10[event]

    for (const status of TASK_STATUSES) {
      if (from.includes(status)) {
        it(`allows ${event} from ${status}`, () => {
          expect(transition(task(status, stateFor[event]), validEvents[event], actor).ok).toBe(true)
        })
      } else {
        it(`rejects ${event} from ${status}`, () => {
          expect(transition(task(status), validEvents[event], actor)).toEqual({
            ok: false,
            error: { code: 'invalid_transition', status, event }
          })
        })
      }
    }

    for (const other of [human, pm, developer, scheduler, server].filter(a => a !== actor)) {
      it(`rejects ${event} by ${other.kind === 'system' ? other.component : other.kind === 'agent' ? other.role : 'human'}`, () => {
        const result = transition(task(from[0]!), validEvents[event], other)
        expect(result.ok).toBe(false)
        if (!result.ok) expect(result.error.code).toBe('actor_not_allowed')
      })
    }
  }

  it('treats Merged as final', () => {
    expect(availableEvents(task('merged'), human)).toEqual([])
    expect(availableEvents(task('merged'), server)).toEqual([])
    expect(availableEvents(task('merged'), scheduler)).toEqual([])
  })
})

describe('createTask', () => {
  it('starts tasks from the human or the PM in Backlog', () => {
    expect(expectOk(createTask(human, false)).status).toBe('backlog')
    expect(expectOk(createTask(pm, true))).toEqual(task('backlog', { humanReview: true }))
  })

  it('rejects anyone else', () => {
    expect(createTask(developer, false).ok).toBe(false)
    expect(createTask(server, false).ok).toBe(false)
  })
})

describe('approve', () => {
  it('requires the Definition of Ready', () => {
    const result = transition(task('backlog'), { type: 'approve', content: { ...content, acceptanceCriteria: [] } }, human)
    expect(result).toEqual({ ok: false, error: { code: 'not_ready', problems: ['missing_acceptance_criteria'] } })
  })
})

describe('claim', () => {
  it('waits until every dependency is Merged', () => {
    const result = transition(task('ready'), { type: 'claim', dependencyStatuses: ['merged', 'agent_review'] }, scheduler)
    expect(result).toEqual({ ok: false, error: { code: 'dependencies_not_merged' } })
  })

  it('claims a task with no dependencies', () => {
    expect(expectOk(transition(task('ready'), { type: 'claim', dependencyStatuses: [] }, scheduler)).status).toBe('in_progress')
  })
})

describe('submit', () => {
  it('rejects an outcome without full evidence at the expected commit', () => {
    const result = transition(task('in_progress'), { type: 'submit', branchAtExpectedCommit: false, evidenceComplete: false }, server)
    expect(result).toEqual({
      ok: false,
      error: { code: 'invalid_outcome', problems: ['branch_not_at_expected_commit', 'evidence_incomplete'] }
    })
  })
})

describe('review rounds', () => {
  it('returns the task to In progress and counts the round', () => {
    expect(expectOk(transition(task('agent_review', { reviewRounds: 1 }), validEvents.changes_requested, server)))
      .toEqual(task('in_progress', { reviewRounds: 2 }))
  })

  it('blocks the task when changes are requested on the fifth round', () => {
    expect(expectOk(transition(task('agent_review', { reviewRounds: 4 }), validEvents.changes_requested, server)))
      .toEqual(task('blocked', { reviewRounds: 5, reason: 'Review-round cap reached (5)' }))
  })

  it('uses the configured cap', () => {
    const limits = { reviewRoundCap: 2, failedRunCap: 3 }
    expect(expectOk(transition(task('agent_review', { reviewRounds: 1 }), validEvents.changes_requested, server, limits)).status)
      .toBe('blocked')
  })

  it('does not count CI failures or human change requests as review rounds', () => {
    expect(expectOk(transition(task('agent_review'), validEvents.ci_failed, server)).reviewRounds).toBe(0)
    expect(expectOk(transition(task('human_review'), validEvents.human_request_changes, human)).reviewRounds).toBe(0)
  })
})

describe('failed runs', () => {
  it('keeps the status so the scheduler retries', () => {
    expect(expectOk(transition(task('in_progress'), validEvents.run_failed, server)))
      .toEqual(task('in_progress', { failedRuns: 1 }))
  })

  it('fails the task on the third failed run', () => {
    expect(expectOk(transition(task('agent_review', { failedRuns: 2 }), validEvents.run_failed, server)))
      .toEqual(task('failed', { failedRuns: 3, reason: 'Failed-run cap reached (3)' }))
  })
})

describe('human review and merging', () => {
  it('sends flagged tasks to Human review once gates pass', () => {
    const flagged = task('agent_review', { humanReview: true })
    expect(expectOk(transition(flagged, validEvents.gates_passed, server)).status).toBe('human_review')
  })

  it('does not send unflagged tasks to Human review', () => {
    expect(transition(task('agent_review'), validEvents.gates_passed, server))
      .toEqual({ ok: false, error: { code: 'not_flagged_for_human_review' } })
  })

  it('never auto-merges a flagged task', () => {
    const flagged = task('agent_review', { humanReview: true })
    expect(transition(flagged, validEvents.merged, server))
      .toEqual({ ok: false, error: { code: 'human_review_required' } })
  })

  it('merges an unflagged task straight from Agent review', () => {
    const event: TaskEvent = { type: 'merged', gates: passingGates, humanApprovedBy: null }
    expect(expectOk(transition(task('agent_review'), event, server)).status).toBe('merged')
  })

  it('needs a human approval to merge from Human review', () => {
    const event: TaskEvent = { type: 'merged', gates: passingGates, humanApprovedBy: null }
    expect(transition(task('human_review'), event, server))
      .toEqual({ ok: false, error: { code: 'human_approval_missing' } })
  })

  it('lists every failed gate', () => {
    const event: TaskEvent = {
      type: 'merged',
      gates: { ...passingGates, requiredChecksPassed: false, mergeable: false },
      humanApprovedBy: null
    }
    expect(transition(task('agent_review'), event, server))
      .toEqual({ ok: false, error: { code: 'gates_failed', gates: ['requiredChecksPassed', 'mergeable'] } })
  })
})

describe('blocking and failing', () => {
  it('records the reason', () => {
    expect(expectOk(transition(task('human_review'), validEvents.block, server)))
      .toEqual(task('blocked', { humanReview: true, reason: 'Requirements contradict each other' }))
  })

  it('requires a reason', () => {
    expect(transition(task('in_progress'), { type: 'fail', reason: '  ' }, server))
      .toEqual({ ok: false, error: { code: 'reason_required' } })
  })
})

describe('resolve', () => {
  it('resets the failed-run counter when resolving Failed', () => {
    const failed = task('failed', { failedRuns: 3, reviewRounds: 2, reason: 'Failed-run cap reached (3)' })
    expect(expectOk(transition(failed, { type: 'resolve', to: 'in_progress' }, human)))
      .toEqual(task('in_progress', { failedRuns: 0, reviewRounds: 2 }))
  })

  it('resets the review-round counter when resolving Blocked', () => {
    const blocked = task('blocked', { failedRuns: 1, reviewRounds: 5, reason: 'Review-round cap reached (5)' })
    expect(expectOk(transition(blocked, { type: 'resolve', to: 'backlog' }, human)))
      .toEqual(task('backlog', { failedRuns: 1, reviewRounds: 0 }))
  })
})

describe('availableEvents', () => {
  it('offers the human what D10 lets them do', () => {
    expect(availableEvents(task('backlog'), human)).toEqual(['approve'])
    expect(availableEvents(task('human_review'), human)).toEqual(['human_request_changes'])
    expect(availableEvents(task('blocked'), human)).toEqual(['resolve'])
  })

  it('offers developer agents nothing', () => {
    expect(availableEvents(task('in_progress'), developer)).toEqual([])
  })
})
