import type { ApiError } from '@corral/contracts'

// A failure the API reports to the client with a status and an ApiError body
export class ApiFailure extends Error {
  readonly status: 400 | 404 | 409
  readonly body: ApiError

  constructor(status: 400 | 404 | 409, body: ApiError) {
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
