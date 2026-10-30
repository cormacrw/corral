import type { RunOutcome } from '@corral/core'
import type { schema } from '@corral/db'

// Every way a run ends, as one write. The checks on the runs table reject
// other combinations; the outcome a role may report is checked there too.
export type RunEnd =
  // An outcome the agent reported
  | { state: 'completed', outcome: Exclude<RunOutcome, 'failed' | 'rate_limited'>, summary: string, headSha?: string | undefined }
  // D3: a pause, not a failure
  | { state: 'completed', outcome: 'rate_limited', summary: string, rateLimitResetAt: Date }
  // A PM turn has no outcome to report: its summary is its reply, if any
  | { state: 'completed', outcome?: undefined, summary: string | null }
  | { state: 'failed', outcome: 'failed', error: string }
  | { state: 'interrupted', outcome?: undefined, error: string }

export function runEndValues(end: RunEnd, endedAt: Date): Partial<typeof schema.runs.$inferInsert> {
  return { endedAt, pmJob: null, ...end }
}
