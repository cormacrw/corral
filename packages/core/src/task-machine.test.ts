import { describe, expect, it } from 'vitest'
import type { Actor } from './actor.ts'
import type { MergeGateFacts } from './merge-gates.ts'
import { TASK_STATUSES, type TaskStatus } from './status.ts'
import {
  availableEvents,
  DEFAULT_LIMITS,
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
  accept: { type: 'accept' },
  send_back: { type: 'send_back' },
  claim: { type: 'claim', dependencies: [{ type: 'task', status: 'merged' }] },
  submit: { type: 'submit', branchAtExpectedCommit: true, evidenceComplete: true },
  changes_requested: { type: 'changes_requested' },
  review_approved: { type: 'review_approved' },
  approval_carried: { type: 'approval_carried' },
  human_approve: { type: 'human_approve' },
  require_human_check: { type: 'require_human_check' },
  ci_failed: { type: 'ci_failed' },
  base_conflict: { type: 'base_conflict', approvedHeadSha: 'approved' },
  head_moved: { type: 'head_moved' },
  merged: { type: 'merged', gates: passingGates },
  merged_outside: { type: 'merged_outside' },
  human_request_changes: { type: 'human_request_changes' },
  block: { type: 'block', reason: 'Requirements contradict each other' },
  fail: { type: 'fail', reason: 'Repository not accessible' },
  run_failed: { type: 'run_failed' },
  resolve: { type: 'resolve', to: 'ready' }
}

// The D10 transition table, written out independently of TRANSITION_RULES:
// event → [allowed from-statuses, actor that may trigger it]
const d10: Record<TaskEventType, [TaskStatus[], Actor]> = {
  approve: [['draft', 'backlog'], human],
  accept: [['draft'], human],
  send_back: [['ready'], human],
  claim: [['ready'], scheduler],
  submit: [['in_progress'], server],
  changes_requested: [['agent_review'], server],
  review_approved: [['agent_review'], server],
  approval_carried: [['in_progress', 'agent_review'], server],
  human_approve: [['human_review'], human],
  require_human_check: [['ready_to_merge'], server],
  ci_failed: [['ready_to_merge'], server],
  base_conflict: [['ready_to_merge'], server],
  head_moved: [['ready_to_merge'], server],
  merged: [['ready_to_merge'], server],
  merged_outside: [['agent_review', 'human_review', 'ready_to_merge'], server],
  human_request_changes: [['human_review', 'ready_to_merge'], human],
  block: [['ready', 'in_progress', 'agent_review', 'human_review', 'ready_to_merge'], server],
  fail: [['in_progress', 'agent_review', 'ready_to_merge'], server],
  run_failed: [['in_progress', 'agent_review'], server],
  resolve: [['blocked', 'failed'], human]
}

// Table rows whose guard needs more than the default state
const stateFor: Partial<Record<TaskEventType, Partial<TaskState>>> = {}

function task(status: TaskStatus, overrides: Partial<TaskState> = {}): TaskState {
  // Flagged tasks are the only ones that may reach Human review
  return { type: 'task', status, humanReview: status === 'human_review', reviewRounds: 0, failedRuns: 0, reason: null, ...overrides }
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

  it('starts the PM\'s plan tasks as Drafts, and only the PM\'s', () => {
    expect(expectOk(createTask(pm, false, true)).status).toBe('draft')
    expect(expectOk(createTask(human, false, true)).status).toBe('backlog')
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

describe('drafts', () => {
  it('go to the board on approval, or to the Backlog on accept', () => {
    expect(expectOk(transition(task('draft'), validEvents.approve, human)).status).toBe('ready')
    expect(expectOk(transition(task('draft'), validEvents.accept, human)).status).toBe('backlog')
  })
})

describe('claim', () => {
  it('waits until every dependency is Merged', () => {
    const result = transition(task('ready'), { type: 'claim', dependencies: [{ type: 'task', status: 'merged' }, { type: 'task', status: 'agent_review' }] }, scheduler)
    expect(result).toEqual({ ok: false, error: { code: 'dependencies_not_merged' } })
  })

  it('claims a build whose design dependency is Approved (D20)', () => {
    expect(expectOk(transition(task('ready'), { type: 'claim', dependencies: [{ type: 'task', status: 'merged' }, { type: 'design', status: 'approved' }] }, scheduler)).status).toBe('in_progress')
  })

  it('claims a task with no dependencies', () => {
    expect(expectOk(transition(task('ready'), { type: 'claim', dependencies: [] }, scheduler)).status).toBe('in_progress')
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

  it('blocks the task when the feedback repeats the previous round', () => {
    expect(expectOk(transition(task('agent_review', { reviewRounds: 1 }), { type: 'changes_requested', similarity: 0.9 }, server)))
      .toEqual(task('blocked', { reviewRounds: 2, reason: 'The reviewer asked for the same changes twice' }))
    expect(expectOk(transition(task('agent_review', { reviewRounds: 1 }), { type: 'changes_requested', similarity: 0.8 }, server)).status)
      .toBe('blocked')
  })

  it('returns the task to In progress when the feedback is different', () => {
    expect(expectOk(transition(task('agent_review', { reviewRounds: 1 }), { type: 'changes_requested', similarity: 0.79 }, server)))
      .toEqual(task('in_progress', { reviewRounds: 2 }))
  })

  it('reports the review-round cap when both apply', () => {
    expect(expectOk(transition(task('agent_review', { reviewRounds: 4 }), { type: 'changes_requested', similarity: 1 }, server)).reason)
      .toBe('Review-round cap reached (5)')
  })

  it('does not count CI failures or human change requests as review rounds', () => {
    expect(expectOk(transition(task('ready_to_merge'), validEvents.ci_failed, server)).reviewRounds).toBe(0)
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

describe('approval and merging', () => {
  it('sends a flagged task to Human review when the reviewer approves', () => {
    expect(expectOk(transition(task('agent_review', { humanReview: true }), validEvents.review_approved, server)).status).toBe('human_review')
  })

  it('sends an unflagged task straight to Ready to merge', () => {
    expect(expectOk(transition(task('agent_review'), validEvents.review_approved, server)).status).toBe('ready_to_merge')
  })

  it('sends an unflagged spike to Human review when the reviewer approves', () => {
    expect(expectOk(transition(task('agent_review', { type: 'spike' }), validEvents.review_approved, server)).status).toBe('human_review')
  })

  it('does not offer generic approval on a design, which needs a version', () => {
    expect(availableEvents(task('human_review', { type: 'design' }), human)).toEqual(['human_request_changes'])
  })

  it('always sends an approved design to Human review, whatever its flag (D20)', () => {
    expect(expectOk(transition(task('agent_review', { type: 'design' }), validEvents.review_approved, server)).status).toBe('human_review')
  })

  it('sends a flagged spike to Human review, and finishes it on the human’s approval', () => {
    expect(expectOk(transition(task('agent_review', { type: 'spike', humanReview: true }), validEvents.review_approved, server)).status).toBe('human_review')
    expect(expectOk(transition(task('human_review', { type: 'spike' }), validEvents.human_approve, human)).status).toBe('merged')
  })

  it('sends a spike back to the developer when the review requests changes, like any task', () => {
    expect(expectOk(transition(task('agent_review', { type: 'spike' }), validEvents.changes_requested, server)))
      .toEqual(task('in_progress', { type: 'spike', reviewRounds: 1 }))
  })

  it('treats bugs like plain tasks', () => {
    expect(expectOk(transition(task('agent_review', { type: 'bug' }), validEvents.review_approved, server)).status).toBe('ready_to_merge')
  })

  it('moves a human-approved task to Ready to merge', () => {
    expect(expectOk(transition(task('human_review'), validEvents.human_approve, human)).status).toBe('ready_to_merge')
  })

  it('sends a task back for a fresh review when a new commit lands', () => {
    expect(expectOk(transition(task('ready_to_merge'), validEvents.head_moved, server)).status).toBe('agent_review')
  })

  it('lets the human pull a task back from Ready to merge', () => {
    expect(expectOk(transition(task('ready_to_merge'), validEvents.human_request_changes, human)).status).toBe('in_progress')
  })

  it('lists every failed gate', () => {
    const event: TaskEvent = { type: 'merged', gates: { ...passingGates, requiredChecksPassed: false, mergeable: false } }
    expect(transition(task('ready_to_merge'), event, server))
      .toEqual({ ok: false, error: { code: 'gates_failed', gates: ['requiredChecksPassed', 'mergeable'] } })
  })

  it('records a merge done outside Corral from any review status', () => {
    expect(expectOk(transition(task('agent_review', { humanReview: true }), validEvents.merged_outside, server)).status).toBe('merged')
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
    expect(availableEvents(task('draft'), human)).toEqual(['approve', 'accept'])
    expect(availableEvents(task('human_review'), human)).toEqual(['human_approve', 'human_request_changes'])
    expect(availableEvents(task('blocked'), human)).toEqual(['resolve'])
  })

  it('offers developer agents nothing', () => {
    expect(availableEvents(task('in_progress'), developer)).toEqual([])
  })
})

describe('rebase-only rounds', () => {
  it('retains approval and the review budget through conflict and resubmission', () => {
    const rebasing = expectOk(transition(task('ready_to_merge', { reviewRounds: 4 }), { type: 'base_conflict', approvedHeadSha: 'approved' }, server))
    expect(rebasing).toMatchObject({ status: 'in_progress', rebaseOnly: true, approvedHeadSha: 'approved', reviewRounds: 4 })
    const submitted = expectOk(transition(rebasing, { type: 'submit', branchAtExpectedCommit: true, evidenceComplete: true }, server))
    expect(submitted).toMatchObject({ status: 'agent_review', rebaseOnly: true, reviewRounds: 4 })
  })

  it.each([false, true])('finishes rebase-only mode on approval (humanReview=%s), including later failure recovery', (humanReview) => {
    let state = expectOk(transition(task('ready_to_merge', { humanReview, reviewRounds: 2 }), { type: 'base_conflict', approvedHeadSha: 'approved' }, server))
    state = expectOk(transition(state, { type: 'submit', branchAtExpectedCommit: true, evidenceComplete: true }, server))
    state = expectOk(transition(state, { type: 'approval_carried' }, server))
    expect(state).toMatchObject({ status: 'ready_to_merge', rebaseOnly: false, approvedHeadSha: 'approved', reviewRounds: 2 })
    state = expectOk(transition(state, { type: 'fail', reason: 'PR closed' }, server))
    state = expectOk(transition(state, { type: 'resolve', to: 'in_progress' }, human))
    expect(state).toMatchObject({ status: 'in_progress', rebaseOnly: false, approvedHeadSha: 'approved', reviewRounds: 2 })
  })

  it('carries an approval straight from the rebase round, before any review', () => {
    const state = expectOk(transition(task('in_progress', { humanReview: true, rebaseOnly: true }), { type: 'approval_carried' }, server))
    expect(state).toMatchObject({ status: 'ready_to_merge', rebaseOnly: false })
  })

  it('sends a carried approval to Human review while a human check is open', () => {
    const state = expectOk(transition(task('agent_review', { rebaseOnly: true }), { type: 'approval_carried', humanCheckOpen: true }, server))
    expect(state).toMatchObject({ status: 'human_review', rebaseOnly: false })
  })

  it('keeps an unfinished rebase-only round when stuck and resolved', () => {
    let state = expectOk(transition(task('ready_to_merge'), { type: 'base_conflict', approvedHeadSha: 'approved' }, server))
    state = expectOk(transition(state, { type: 'block', reason: 'Which resolution?' }, server))
    state = expectOk(transition(state, { type: 'resolve', to: 'in_progress' }, human))
    expect(state).toMatchObject({ status: 'in_progress', rebaseOnly: true, approvedHeadSha: 'approved' })
  })

  it('returns to a normal round when the rebase reviewer requests changes', () => {
    const result = expectOk(transition(task('agent_review', { rebaseOnly: true, reviewRounds: 1 }), { type: 'changes_requested' }, server))
    expect(result).toMatchObject({ status: 'in_progress', rebaseOnly: false, reviewRounds: 2 })
  })
})

describe('DEFAULT_LIMITS', () => {
  it('holds the PRD defaults and cannot be changed', () => {
    expect(DEFAULT_LIMITS).toEqual({ reviewRoundCap: 5, failedRunCap: 3 })
    expect(() => {
      // @ts-expect-error the limits are read-only
      DEFAULT_LIMITS.reviewRoundCap = 1
    }).toThrow(TypeError)
    expect(DEFAULT_LIMITS.reviewRoundCap).toBe(5)
  })
})
