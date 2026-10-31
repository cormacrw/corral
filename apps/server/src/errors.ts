import type { ApiError } from '@corral/contracts'
import type { MergeGate, ReadyProblem, TransitionError } from '@corral/core'

// A failure the API reports to the client with a status and an ApiError body
export class ApiFailure extends Error {
  readonly status: 400 | 403 | 404 | 409 | 413 | 503
  readonly body: ApiError

  constructor(status: 400 | 403 | 404 | 409 | 413 | 503, body: ApiError) {
    super(body.code)
    this.status = status
    this.body = body
  }
}

export const notFound = () => new ApiFailure(404, { code: 'not_found' })

// Maps Postgres constraint errors (both drivers report the SQLSTATE `code`)
// to API errors, so the database stays the last line of defence for
// uniqueness, e.g. one project per repository (D13)
export function fromDatabaseError(error: unknown): ApiFailure | null {
  for (let e: unknown = error; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
    const { code, constraint } = e as { code?: unknown, constraint?: unknown }
    const name = typeof constraint === 'string' ? constraint : null
    if (code === '23505') return new ApiFailure(409, { code: 'conflict', constraint: name })
    if (code === '23514' || code === '23503') {
      return new ApiFailure(400, { code: 'invalid_input', issues: [{ constraint: name }] })
    }
  }
  return null
}

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
const statusName = (status: string) => { const name = words(status); return name[0]!.toUpperCase() + name.slice(1) }

function transitionReason(reason: TransitionError): string {
  switch (reason.code) {
    case 'invalid_transition': return `This move doesn't apply to a task in ${statusName(reason.status)}`
    case 'actor_not_allowed': return `This move isn't allowed for ${reason.actor ? `the ${reason.actor}` : 'this actor'}`
    case 'not_ready': return `This task needs ${reason.problems.map(p => READY_PROBLEMS[p]).join(', ')}`
    case 'dependencies_not_merged': return 'The tasks this one depends on haven\'t merged yet'
    case 'invalid_outcome': return `This outcome can't be accepted: ${reason.problems.map(words).join(', ')}`
    case 'gates_failed': return `Merging needs ${reason.gates.map(g => MERGE_GATE_NAMES[g]).join(', ')}`
    case 'reason_required': return 'This move needs a reason'
  }
}

// A failure in plain words, for the people reading Activity and confirm cards.
// The PM's tool responses keep the structured error instead (COR-240).
export function failureReason(error: unknown): string {
  const failure = error instanceof ApiFailure ? error : fromDatabaseError(error)
  if (!failure) return error instanceof Error ? error.message : String(error)
  const { body } = failure
  if (body.code === 'transition_rejected') return transitionReason(body.reason)
  if (body.code === 'run_not_live') return body.reason
  if (body.code === 'conflict' && body.constraint) return `conflict: ${words(body.constraint)}`
  return words(body.code)
}
