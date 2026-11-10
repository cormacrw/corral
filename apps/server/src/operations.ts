import { ACTIVE_OPERATION_STATES, SERVER_ACTOR, type Actor, type EpicDecisionAnswer, type EpicDecisionRequest, type EpicRebaseDecision, type OperationKind, type OperationState } from '@corral/core'
import { schema, type Database, type Executor, type OperationRow, type ProjectRow } from '@corral/db'
import { and, desc, eq, inArray, notInArray, notLike, type SQL } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { appendAudit, auditEvent } from './audit.ts'
import { ApiFailure, notFound } from './errors.ts'
import type { EventBus } from './events.ts'
import type { GitHubClient } from './github.ts'
import type { RunnerHub } from './runner-hub.ts'

// The journal of writes to a task's shared branch (D27): integrating a
// submission, or rebasing or fixing the whole branch. One active operation per
// task with subtasks is its writer lock. EpicSynchronizer and TaskIntegrator
// both step their operations through what's here.

const { epics, taskIntegrationOperations: operations } = schema

// What both writers of the shared branch work with
export interface BranchWriterDeps {
  db: Database
  events: EventBus
  github: GitHubClient
  runner: RunnerHub
  gate: { readonly halted: boolean }
  now: () => Date
  wake: (taskIds: string[]) => void
}

// Why an operation ended, where something reads it back. The stored text is
// what's matched, so each keeps its wording; `legacy` holds wordings rows from
// before D31 have.
const ENDINGS = {
  // Nothing against these commits: they retry at once
  targetMoved: { text: 'The task\'s branch moved', legacy: ['The epic branch moved', 'The parent branch moved'] },
  interrupted: { text: 'Interrupted before a candidate was ready', legacy: [] },
  deliveryMerged: { text: 'The task\'s PR merged', legacy: ['The epic PR merged', 'The parent PR merged'] },
  // A rebase that met a conflict and was left for its final checkpoint
  // (COR-445). It's pending while nothing newer has rebased or fixed the
  // epic, so the journal alone says so, and any later rebase clears it.
  conflictDeferred: { text: 'Conflict left for the final checkpoint', legacy: [] },
  // The branch reached the target some other way, with no rebase of ours to be newer
  conflictGone: { text: 'The task\'s branch no longer conflicts', legacy: ['The epic branch no longer conflicts', 'The parent branch no longer conflicts'] },
  cancelled: { text: 'The task left Ready to merge', legacy: [] }
} as const satisfies Record<string, { text: string, legacy: readonly string[] }>

export type OperationEnding = keyof typeof ENDINGS

export const endingText = (ending: OperationEnding): string => ENDINGS[ending].text

const storedEndings = (...endings: OperationEnding[]): string[] => endings.flatMap(e => [ENDINGS[e].text, ...ENDINGS[e].legacy])

export const endedBy = (error: string | null, ...endings: OperationEnding[]): boolean => error !== null && storedEndings(...endings).includes(error)

// A job the runner couldn't answer: a network blip or a lost runner says
// nothing against the work, so it's retried on a later pass. Stored as a prefix
// with the error after it.
const UNAVAILABLE = 'The runner could not finish the job'
export const runnerUnavailable = (detail: string): string => `${UNAVAILABLE}: ${detail}`

// Failed operations that count against the work: anything but these endings
// and the runner being unavailable
export function countsAsFailure(endings: OperationEnding[]): SQL {
  return and(notInArray(operations.error, storedEndings(...endings)), notLike(operations.error, `${UNAVAILABLE}%`))!
}

async function nextEpoch(tx: Executor, epicId: string): Promise<number> {
  const [newest] = await tx.select({ leaseEpoch: operations.leaseEpoch }).from(operations).where(eq(operations.epicId, epicId)).orderBy(desc(operations.leaseEpoch)).limit(1)
  return (newest?.leaseEpoch ?? 0) + 1
}

// Writes the intent, before any git happens. Null when another operation
// holds the writer lock.
export async function beginOperation(tx: Executor, values: Omit<typeof operations.$inferInsert, 'leaseEpoch'> & { epicId: string }): Promise<OperationRow | null> {
  const [created] = await tx.insert(operations).values({ ...values, leaseEpoch: await nextEpoch(tx, values.epicId) }).onConflictDoNothing().returning()
  return created ?? null
}

// Compare-and-set: writes only while the operation is still in one of `from`
// on the same epoch, so a step that lost the race writes nothing. Null then.
export async function moveOperation(db: Executor, operation: Pick<OperationRow, 'id' | 'leaseEpoch'>, from: readonly OperationState[], values: Partial<typeof operations.$inferInsert>): Promise<OperationRow | null> {
  const [moved] = await db.update(operations).set(values)
    .where(and(eq(operations.id, operation.id), inArray(operations.state, [...from]), eq(operations.leaseEpoch, operation.leaseEpoch))).returning()
  return moved ?? null
}

export async function activeOperation(db: Executor, epicId: string, kind?: OperationKind): Promise<OperationRow | null> {
  const [row] = await db.select().from(operations).where(and(eq(operations.epicId, epicId), kind ? eq(operations.kind, kind) : undefined, inArray(operations.state, [...ACTIVE_OPERATION_STATES])))
  return row ?? null
}

export const activeRebase = (db: Executor, epicId: string) => activeOperation(db, epicId, 'rebase')

// activeRebase for many epics at once
export async function rebasingEpics(db: Executor, epicIds: string[]): Promise<Set<string>> {
  if (epicIds.length === 0) return new Set()
  const rows = await db.select({ epicId: operations.epicId }).from(operations).where(and(inArray(operations.epicId, epicIds), eq(operations.kind, 'rebase'), inArray(operations.state, [...ACTIVE_OPERATION_STATES])))
  return new Set(rows.map(r => r.epicId))
}

// Each epic's rebase left for its final checkpoint, while nothing newer has run
export async function deferredConflicts(db: Executor, epicIds: string[]): Promise<Map<string, OperationRow>> {
  if (epicIds.length === 0) return new Map()
  const newest = await db.selectDistinctOn([operations.epicId]).from(operations)
    .where(and(inArray(operations.epicId, epicIds), eq(operations.kind, 'rebase')))
    .orderBy(operations.epicId, desc(operations.leaseEpoch))
  return new Map(newest.filter(o => endedBy(o.error, 'conflictDeferred')).map(o => [o.epicId, o]))
}

// Stops synchronizing until a human retries. Recovery has run out, so it's on
// the epic and a Needs you item until Retry or the merge (D11, D29).
export async function recordSyncFailure(db: Executor, project: Pick<ProjectRow, 'id'>, epicId: string, error: string, now: Date): Promise<void> {
  await db.update(epics).set({ syncError: error, updatedAt: now }).where(eq(epics.id, epicId))
  const fix = (await activeRebase(db, epicId))?.fix ?? undefined
  await appendAudit(db, { projectId: project.id, actor: SERVER_ACTOR }, auditEvent('epic.pr', { epicId, event: 'sync_failed', summary: error, ...(fix && { fix }) }))
}

// A human asks for another go, which counts failures afresh. A fix that
// failed to publish keeps its candidate and just pushes again; a fix
// with no report left starts another developer run.
export async function retrySync(db: Database, epicId: string, actor: Actor, now: Date): Promise<void> {
  await db.transaction(async (tx) => {
    const [epic] = await tx.select().from(epics).where(eq(epics.id, epicId)).for('update')
    if (!epic) throw notFound()
    if (!epic.syncError) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_sync_not_failed' })
    await tx.update(epics).set({ syncError: null, syncRetriedAt: now, updatedAt: now }).where(eq(epics.id, epicId))
    await tx.update(operations).set({ pushAttempts: 0, fixAttempts: 0 }).where(and(eq(operations.epicId, epicId), inArray(operations.state, [...ACTIVE_OPERATION_STATES])))
    const fix = (await activeRebase(tx, epicId))?.fix ?? undefined
    await appendAudit(tx, { projectId: epic.projectId, actor }, auditEvent('epic.pr', { epicId, event: 'sync_retried', ...(fix && { fix }) }))
  })
}

// The question an epic fix waits on, if it does (D29). With no task to block,
// the newest unanswered one is all there is to it.
export function openDecision(operation: Pick<OperationRow, 'decisions'>): EpicRebaseDecision | null {
  const newest = operation.decisions.at(-1)
  return newest && !newest.answer ? newest : null
}

// The human's answers, as an agent working on the operation is told them
export const answeredDecisions = (operation: Pick<OperationRow, 'decisions'>) =>
  operation.decisions.filter(d => d.answer).map(d => ({ question: d.question, answer: [d.answer!.label, d.answer!.text].filter(Boolean).join(': ') }))

type AuditScope = { projectId: string, taskId?: string, actor: Actor }

// Puts a question on the operation, which keeps the writer lock until the
// human answers
export async function raiseDecision(tx: Executor, operation: OperationRow, request: EpicDecisionRequest, runId: string, scope: AuditScope, now = new Date()): Promise<void> {
  const decision: EpicRebaseDecision = { ...request, id: randomUUID(), runId, raisedAt: now.toISOString(), answer: null }
  await tx.update(operations).set({ decisions: [...operation.decisions, decision], updatedAt: now }).where(eq(operations.id, operation.id))
  await appendAudit(tx, scope, auditEvent('epic.pr', { epicId: operation.epicId, event: 'decision_requested', operationId: operation.id, decisionId: decision.id, summary: request.question, bindingDecision: request.bindingDecision ?? null, alternatives: request.alternatives.map(a => a.label), affectedChanges: request.affectedChanges }))
}

// Records the human's reply on the journal, where the publish step reads what
// it means for approval. A written answer counts as a behaviour change,
// because nothing shows it isn't.
export async function answerDecision(tx: Executor, operation: OperationRow, decision: EpicRebaseDecision, input: { alternative?: number | undefined, text?: string | undefined }, scope: AuditScope): Promise<EpicDecisionAnswer> {
  const choice = input.alternative === undefined ? null : decision.alternatives[input.alternative]
  if (choice === undefined) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ message: 'That alternative isn\'t on this question' }] })
  const answer = { alternative: input.alternative ?? null, label: choice?.label ?? 'A written answer', text: input.text ?? null, changesBehaviour: choice?.changesBehaviour ?? true, at: new Date().toISOString() }
  await tx.update(operations).set({ decisions: operation.decisions.map(d => d.id === decision.id ? { ...d, answer } : d), updatedAt: new Date() }).where(eq(operations.id, operation.id))
  await appendAudit(tx, scope, auditEvent('epic.pr', { epicId: operation.epicId, event: 'decision_answered', operationId: operation.id, decisionId: decision.id, summary: `${decision.question} ${answer.label}${input.text ? `: ${input.text}` : ''}`, changesBehaviour: answer.changesBehaviour }))
  return answer
}
