import type { ApiError } from '@corral/contracts'
import { errorText, transitionReason, type Actor } from '@corral/core'

export class ApiFailure extends Error {
  readonly status: 400 | 403 | 404 | 409 | 413 | 502 | 503
  readonly body: ApiError

  constructor(status: 400 | 403 | 404 | 409 | 413 | 502 | 503, body: ApiError) {
    super(body.code)
    this.status = status
    this.body = body
  }
}

export const notFound = () => new ApiFailure(404, { code: 'not_found' })

// Actions only the human takes. Each says no the way its route always has.
export function requireHuman(actor: Actor, refusal: () => ApiFailure = () => new ApiFailure(403, { code: 'forbidden' })): asserts actor is Extract<Actor, { kind: 'human' }> {
  if (actor.kind !== 'human') throw refusal()
}

// Maps Postgres constraint errors (both drivers report the SQLSTATE `code`)
// to API errors, so the database stays the last line of defence for
// uniqueness, e.g. one project per repository (D13)
export function fromDatabaseError(error: unknown): ApiFailure | null {
  for (let e: unknown = error; typeof e === 'object' && e !== null; e = (e as { cause?: unknown }).cause) {
    const { code, constraint } = e as { code?: unknown, constraint?: unknown }
    const name = typeof constraint === 'string' ? constraint : null
    // IDs come from URLs; a malformed one is simply unknown
    if (code === '22P02') return notFound()
    if (code === '23505') return new ApiFailure(409, { code: 'conflict', constraint: name })
    if (code === '23514' || code === '23503') {
      return new ApiFailure(400, { code: 'invalid_input', issues: [{ constraint: name }] })
    }
  }
  return null
}

const words = (code: string) => code.replaceAll('_', ' ')

// A failure in plain words, for the people reading Activity and confirm cards.
// The PM's tool responses keep the structured error instead (COR-240).
export function failureReason(error: unknown): string {
  const failure = error instanceof ApiFailure ? error : fromDatabaseError(error)
  if (!failure) return errorText(error)
  const { body } = failure
  if (body.code === 'transition_rejected') return transitionReason(body.reason)
  if (body.code === 'run_not_live') return body.reason
  if (body.code === 'conflict' && body.constraint) return `conflict: ${words(body.constraint)}`
  return words(body.code)
}
