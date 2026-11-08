import type { EpicFixRun, EpicReviewActionInput } from '@corral/contracts'
import { ACTIVE_OPERATION_STATES, type Actor, type EpicFixKind, type GateCheck } from '@corral/core'
import { schema, type EpicRow, type Executor, type OperationRow, type ProjectRow, type RunRow } from '@corral/db'
import { and, count, desc, eq, gte, inArray, isNotNull } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { ApiFailure } from './errors.ts'
import { answerDecision, beginOperation, openDecision, recordSyncFailure } from './operations.ts'
import { MAX_CI_FIXES } from './retries.ts'

const { agents, epics, projects, runs, taskIntegrationOperations: operations } = schema

// Developer runs on one operation that come to nothing before a human has to
// retry: failed, interrupted unexpectedly, or refused at the publish check.
// Published CI fixes since the last retry stop at MAX_CI_FIXES, and review
// fixes at the project's review round cap.
const MAX_FIX_ATTEMPTS = 3

const FIX_LABEL: Record<EpicFixKind, string> = { conflict: 'rebase conflict', ci: 'CI failure', review: 'integration review changes' }

// Takes the writer lock for a CI or review fix, or null when something else
// holds it. `ontoSha` is the head itself: the candidate builds on it, and any
// rebase comes after, at the next checkpoint. Past the bound the operation
// still opens, stopped, so that Retry has a run to start.
export async function openEpicFix(tx: Executor, project: ProjectRow, epic: EpicRow, input: { fix: 'ci' | 'review', brief: string, headSha: string, checks?: GateCheck[] }, actor: Actor, now: Date): Promise<OperationRow | null> {
  const created = await beginOperation(tx, { epicId: epic.id, kind: 'rebase', state: 'running', expectedTargetSha: input.headSha, ontoSha: input.headSha, fix: input.fix, fixBrief: input.brief, fixChecks: input.checks ?? null })
  if (!created) return null
  await appendAudit(tx, { projectId: project.id, actor }, auditEvent('epic.pr', { epicId: epic.id, event: 'fix_started', fix: input.fix, operationId: created.id, summary: input.brief }))
  const [done] = await tx.select({ n: count() }).from(operations).where(and(eq(operations.epicId, epic.id), eq(operations.fix, input.fix), eq(operations.state, 'succeeded'), epic.syncRetriedAt ? gte(operations.createdAt, epic.syncRetriedAt) : undefined))
  const bound = input.fix === 'ci' ? MAX_CI_FIXES : project.reviewRoundCap
  if (done!.n >= bound) await recordSyncFailure(tx, project, epic.id, `${done!.n} fixes for ${FIX_LABEL[input.fix]} have been published and it's still failing. The last: ${input.brief}`, now)
  return created
}

// The developer's runs on an epic, newest first. Runs from before CI and
// review fixes were all conflict fixes.
export async function epicFixRuns(db: Executor, epicId: string): Promise<EpicFixRun[]> {
  const rows = await db.select({ run: runs, developer: agents.name, reason: operations.fixBrief }).from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId)).leftJoin(operations, eq(operations.id, runs.operationId))
    .where(and(eq(runs.epicId, epicId), eq(runs.role, 'developer'), isNotNull(runs.endedAt))).orderBy(desc(runs.number))
  return rows.map(({ run, developer, reason }) => ({
    runId: run.id, runNumber: run.number, fix: run.fixKind ?? 'conflict', developer, reason: reason ?? '', state: run.state, outcome: run.outcome,
    summary: run.summary ?? run.error, behaviourChanged: run.behaviourChanged, reReviewed: run.reReviewed, at: run.endedAt!.toISOString()
  }))
}

// Before a failed developer run on an epic ends, in its transaction. Counts
// the attempt on the operation; true when that stopped the epic.
export async function countFixFailure(tx: Executor, run: RunRow, error: string, now: Date): Promise<boolean> {
  const operation = await activeFixOperation(tx, run)
  if (!operation) return false
  const attempts = operation.fixAttempts + 1
  await tx.update(operations).set({ fixAttempts: attempts, updatedAt: now }).where(eq(operations.id, operation.id))
  if (attempts < MAX_FIX_ATTEMPTS) return false
  const [project] = await tx.select().from(projects).where(eq(projects.id, run.projectId!))
  await recordSyncFailure(tx, project!, run.epicId!, `The developer failed ${attempts} times to fix the ${FIX_LABEL[operation.fix!]}. The last run: ${error}`, now)
  return true
}

// Reports and claims take a fix's operation before its run; anything else
// that writes both keeps that lock order by taking this first
export async function lockFixOperation(tx: Executor, run: Pick<RunRow, 'operationId'>): Promise<void> {
  if (run.operationId) await tx.select({ id: operations.id }).from(operations).where(eq(operations.id, run.operationId)).for('update')
}

// The state of a fix's operation, if the run has one
export async function fixOperationState(db: Executor, run: Pick<RunRow, 'operationId'>): Promise<OperationRow['state'] | null> {
  if (!run.operationId) return null
  const [operation] = await db.select({ state: operations.state }).from(operations).where(eq(operations.id, run.operationId))
  return operation?.state ?? null
}

// The fix's operation, locked, while it is still active
export async function activeFixOperation(tx: Executor, run: Pick<RunRow, 'operationId'>): Promise<OperationRow | null> {
  if (!run.operationId) return null
  const [operation] = await tx.select().from(operations).where(and(eq(operations.id, run.operationId), inArray(operations.state, [...ACTIVE_OPERATION_STATES]))).for('update')
  return operation ?? null
}

// The human's answer lets the claim start another run on the same operation
export async function answerEpicDecision(db: Executor, epicId: string, input: Pick<EpicReviewActionInput, 'alternative' | 'text'>, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const [operation] = await tx.select().from(operations).where(and(eq(operations.epicId, epicId), isNotNull(operations.fix), inArray(operations.state, [...ACTIVE_OPERATION_STATES]))).for('update')
    const decision = operation && openDecision(operation)
    if (!operation || !decision) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_decision_changed' })
    const [epic] = await tx.select({ projectId: epics.projectId }).from(epics).where(eq(epics.id, epicId))
    await answerDecision(tx, operation, decision, input, { projectId: epic!.projectId, actor })
  })
}
