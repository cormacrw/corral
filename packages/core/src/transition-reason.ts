import type { MergeGate } from './merge-gates.ts'
import type { ReadyProblem } from './ready.ts'
import { TASK_STATUS_LABELS } from './status.ts'
import type { TransitionError } from './task-machine.ts'

const READY_PROBLEMS: Record<ReadyProblem, string> = {
  missing_title: 'a title',
  missing_description: 'a description',
  missing_acceptance_criteria: 'acceptance criteria',
  blank_acceptance_criterion: 'no blank acceptance criteria'
}

const MERGE_GATE_NAMES: Record<MergeGate, string> = {
  approvalIsForHeadCommit: 'approval of the latest commit',
  requiredChecksPassed: 'passing required checks',
  evidenceComplete: 'complete evidence',
  mergeable: 'a mergeable PR'
}

const words = (code: string) => code.replaceAll('_', ' ')

// A refused move in plain words, for Activity, confirm cards and the web's toasts
export function transitionReason(reason: TransitionError): string {
  switch (reason.code) {
    case 'invalid_transition': return `This move doesn't apply to a task in ${TASK_STATUS_LABELS[reason.status]}`
    case 'actor_not_allowed': return `This move isn't allowed for ${reason.actor ? `the ${reason.actor}` : 'this actor'}`
    case 'not_ready': return `This task needs ${reason.problems.map(p => READY_PROBLEMS[p]).join(', ')}`
    case 'dependencies_not_merged': return 'The tasks this one depends on haven\'t merged yet'
    case 'invalid_outcome': return `This outcome can't be accepted: ${reason.problems.map(words).join(', ')}`
    case 'gates_failed': return `Merging needs ${reason.gates.map(g => MERGE_GATE_NAMES[g]).join(', ')}`
    case 'integration_unconfirmed': return 'This task\'s commit isn\'t confirmed on the task\'s branch yet'
    case 'reason_required': return 'This move needs a reason'
  }
}
