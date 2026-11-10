import { ACTIVE_RUN_STATES, SERVER_ACTOR, type EpicFixKind, type RebaseReview, type RunOutcome } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, eq, inArray, type SQL } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'

const { runs, tasks } = schema

// Every way a run ends, as one write. The checks on the runs table reject
// other combinations; the outcome a role may report is checked there too.
export type RunEnd =
  // An outcome the agent reported
  | { state: 'completed', outcome: Exclude<RunOutcome, 'failed' | 'rate_limited'>, summary: string, headSha?: string | undefined, review?: RebaseReview | undefined, conflictedFiles?: string[] | undefined, behaviourChanged?: boolean | undefined, fixKind?: EpicFixKind | undefined, reReviewed?: boolean | undefined }
  // D3: a pause, not a failure
  | { state: 'completed', outcome: 'rate_limited', summary: string, rateLimitResetAt: Date }
  // A PM turn has no outcome to report: its summary is its reply, if any
  | { state: 'completed', outcome?: undefined, summary: string | null }
  | { state: 'failed', outcome: 'failed', error: string }
  | { state: 'interrupted', outcome?: undefined, error: string, headSha?: string | null | undefined }

interface EndingRun {
  id: string
  number: number
  projectId: string | null
  taskId: string | null
}

type RunFields = Partial<typeof runs.$inferInsert>

function runEndValues(end: RunEnd, endedAt: Date): RunFields {
  return { endedAt, pmJob: null, ...end }
}

// The only way a run ends: if it is still active, records the end and the
// run.ended audit, and releases the task's lease if the run still holds it.
// Whether this ended it: an outcome accepted since the run was read stands.
export async function endRunIn(tx: Executor, run: EndingRun, end: RunEnd, endedAt: Date): Promise<boolean> {
  const [ended] = await tx.update(runs).set(runEndValues(end, endedAt))
    .where(and(eq(runs.id, run.id), inArray(runs.state, [...ACTIVE_RUN_STATES]))).returning({ id: runs.id })
  if (run.taskId) {
    await tx.update(tasks).set({ leaseRunId: null, leaseRole: null, leaseExpiresAt: null, leaseHeartbeatAt: null, updatedAt: endedAt })
      .where(and(eq(tasks.id, run.taskId), eq(tasks.leaseRunId, run.id)))
  }
  if (ended) {
    await appendAudit(tx, { projectId: run.projectId, taskId: run.taskId, actor: SERVER_ACTOR }, auditEvent('run.ended', {
      runId: run.id, runNumber: run.number, state: end.state, outcome: end.outcome ?? null, error: 'error' in end ? end.error : null,
      ...('review' in end && end.review !== undefined && { review: end.review }),
      ...('conflictedFiles' in end && end.conflictedFiles !== undefined && { conflictedFiles: end.conflictedFiles }),
      ...('behaviourChanged' in end && end.behaviourChanged !== undefined && { behaviourChanged: end.behaviourChanged })
    }))
  }
  return ended !== undefined
}

// Ends every active run `where` picks, e.g. all runs on an epic whose PR
// changed under them. The ids of the runs it ended.
export async function endActiveRuns(tx: Executor, where: SQL, end: RunEnd, endedAt: Date): Promise<string[]> {
  const live = await tx.select({ id: runs.id, number: runs.number, projectId: runs.projectId, taskId: runs.taskId }).from(runs)
    .where(and(where, inArray(runs.state, [...ACTIVE_RUN_STATES])))
  const ended: string[] = []
  for (const run of live) {
    if (await endRunIn(tx, run, end, endedAt)) ended.push(run.id)
  }
  return ended
}

// A run.ended replayed after the server took the run as lost with its runner:
// what the agent really did replaces the interruption. Already audited and
// released when it was interrupted.
export async function restoreRunEnd(tx: Executor, runId: string, end: RunEnd, endedAt: Date, fields: RunFields = {}): Promise<void> {
  await tx.update(runs).set({ ...runEndValues(end, endedAt), ...fields }).where(and(eq(runs.id, runId), eq(runs.state, 'interrupted')))
}
