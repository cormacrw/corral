import type { InboxActionInput } from '@corral/contracts'
import type { Actor, EpicDecisionRequest, EpicRebaseDecision, ResolutionReview } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { randomUUID } from 'node:crypto'
import { appendAudit, auditEvent, type ApprovalChange } from './audit.ts'
import { ApiFailure } from './errors.ts'
import { addComment, applyTransition, lockTask, type ProjectRow, type TaskRow } from './tasks.ts'

const { epics, taskIntegrationOperations: operations, tasks } = schema
type OperationRow = typeof operations.$inferSelect
type EpicRow = typeof epics.$inferSelect

export const ACTIVE_OPERATION = ['pending', 'running', 'reconciling'] as const

// The states in which an epic's head carries an approval worth keeping. Legacy
// `conflict` epics got there from one of the other two.
export const APPROVED_STATES: EpicRow['reviewState'][] = ['human_review', 'ready_to_merge', 'conflict']

export const shortSha = (sha: string | null) => sha?.slice(0, 10) ?? 'unknown'

export type ApprovalFate = { kept: boolean, reason: string }

// The question a resolution task is Blocked on, if it is. Only the newest can
// be: an older one without an answer was closed from the board, and one still
// unanswered no longer describes the task once it's moved on or blocked anew.
export function waitingOn(operation: Pick<OperationRow, 'decisions'>, task: { status: string, statusReason: string | null }): EpicRebaseDecision | null {
  const newest = operation.decisions.at(-1)
  return newest && !newest.answer && task.status === 'blocked' && task.statusReason === newest.question ? newest : null
}

// The question an epic fix waits on, if it does (D29). With no task to block,
// the newest unanswered one is all there is to it.
export const openDecision = (operation: Pick<OperationRow, 'decisions'>): EpicRebaseDecision | null => {
  const newest = operation.decisions.at(-1)
  return newest && !newest.answer ? newest : null
}

// What a human's reply means for approval. A written answer counts as a
// behaviour change, because nothing shows it isn't.
export function answerOn(decision: EpicRebaseDecision, input: { alternative?: number | undefined, text?: string | undefined }) {
  const choice = input.alternative === undefined ? null : decision.alternatives[input.alternative]
  if (choice === undefined) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ message: 'That alternative isn\'t on this question' }] })
  return { alternative: input.alternative ?? null, label: choice?.label ?? 'A written answer', text: input.text ?? null, changesBehaviour: choice?.changesBehaviour ?? true, at: new Date().toISOString() }
}

// What publishing a developer's fix means for approval (D29). Only the
// developer's report on exactly this commit can keep it, and for a conflict
// only with the server's compare agreeing.
function fixFate(operation: OperationRow, commitSha: string): ApprovalFate {
  const report = operation.fixReport
  if (report?.headSha !== commitSha) return { kept: false, reason: `No developer report covers ${shortSha(commitSha)}.` }
  const unanswered = operation.decisions.find(d => !d.answer)
  if (unanswered) return { kept: false, reason: `The question "${unanswered.question}" was closed without an answer.` }
  const changed = operation.decisions.find(d => d.answer?.changesBehaviour)
  if (changed) return { kept: false, reason: `The human's decision changes approved behaviour: ${changed.answer!.label}.` }
  if (report.behaviourChanged) return { kept: false, reason: `The developer reported a behaviour change: ${report.summary}` }
  if (operation.fix === 'review') return { kept: false, reason: 'Integration review changes are always reviewed again.' }
  if (operation.fix === 'ci') return { kept: true, reason: `The developer reported no behaviour change; CI runs again on the new head: ${report.summary}` }
  if (report.checkError) return { kept: false, reason: `The server could not compare the approved and rebased changes: ${report.checkError}` }
  if (!report.outsideConflicts) return { kept: false, reason: `The server never compared the approved and rebased changes of ${shortSha(commitSha)}.` }
  if (report.outsideConflicts.length) return { kept: false, reason: `The resolution changed files outside the conflicts: ${report.outsideConflicts.join(', ')}.` }
  return { kept: true, reason: `The developer reported no behaviour change and the server found differences only in the conflicted files: ${report.summary}` }
}

// Whether approval survives a rebase being published as `commitSha`, or null
// when there's no approval to speak of. Every path to `kept` starts from the
// journaled operation having begun on the exact approved head, so a commit that
// reached the branch any other way can't inherit anything (COR-291).
export function approvalFate(operation: OperationRow, epic: EpicRow, commitSha: string): ApprovalFate | null {
  if (!APPROVED_STATES.includes(epic.reviewState) || commitSha === operation.expectedTargetSha) return null
  if (!epic.approvedHeadSha || epic.prHeadSha !== operation.expectedTargetSha) {
    return { kept: false, reason: `The rebase started from ${shortSha(operation.expectedTargetSha)}, which isn't the approved head ${shortSha(epic.prHeadSha)}.` }
  }
  if (operation.fix) return fixFate(operation, commitSha)
  if (!operation.resolutionTaskId) return { kept: true, reason: 'A clean rebase changes nothing that was approved; checks run again on the new head.' }
  const review = operation.resolutionReview
  if (review?.headSha !== commitSha) return { kept: false, reason: `No review of the resolution covers ${shortSha(commitSha)}.` }
  const unanswered = operation.decisions.find(d => !d.answer)
  if (unanswered) return { kept: false, reason: `The question "${unanswered.question}" was closed without an answer.` }
  const changed = operation.decisions.find(d => d.answer?.changesBehaviour)
  if (changed) return { kept: false, reason: `The human's decision changes approved behaviour: ${changed.answer!.label}.` }
  if (!review.preserved) return { kept: false, reason: `The reviewer found a behaviour change: ${review.summary}` }
  if (review.checkError) return { kept: false, reason: `The server could not compare the approved and rebased changes: ${review.checkError}` }
  // Fails closed: no compare on record is no validation
  if (!review.outsideConflicts) return { kept: false, reason: `The server never compared the approved and rebased changes of ${shortSha(commitSha)}.` }
  if (review.outsideConflicts.length) return { kept: false, reason: `The resolution changed files outside the conflicts: ${review.outsideConflicts.join(', ')}.` }
  return { kept: true, reason: `The reviewer confirmed the resolution keeps the approved behaviour: ${review.summary}` }
}

// The history line that says what was approved, what it became and why
export function approvalChange(operation: OperationRow, epic: EpicRow, commitSha: string, fate: ApprovalFate): ApprovalChange {
  const review = operation.resolutionReview
  return {
    event: fate.kept ? 'approval_retained' : 'approval_invalidated',
    approvedHeadSha: epic.approvedHeadSha,
    from: operation.expectedTargetSha,
    to: commitSha,
    ontoSha: operation.ontoSha,
    operationId: operation.id,
    resolutionTaskId: operation.resolutionTaskId,
    ...(operation.fixReport && { fixRunId: operation.fixReport.runId }),
    resolutionReview: review?.headSha === commitSha ? { runId: review.runId, preserved: review.preserved, summary: review.summary } : null,
    reason: fate.reason,
    summary: `Approved ${shortSha(epic.approvedHeadSha)}, rebased ${shortSha(operation.expectedTargetSha)} to ${shortSha(commitSha)}. ${fate.reason}`
  }
}

async function activeResolution(tx: Executor, taskId: string): Promise<OperationRow | null> {
  const [row] = await tx.select().from(operations).where(and(eq(operations.resolutionTaskId, taskId), inArray(operations.state, [...ACTIVE_OPERATION]))).for('update')
  return row ?? null
}

export async function recordResolutionReview(tx: Executor, taskId: string, review: ResolutionReview): Promise<void> {
  await tx.update(operations).set({ resolutionReview: review, updatedAt: new Date() }).where(and(eq(operations.resolutionTaskId, taskId), inArray(operations.state, [...ACTIVE_OPERATION])))
}

// Puts a question on the operation. The caller blocks the task with it, and the
// operation keeps the writer lock until the human answers.
export async function raiseDecision(tx: Executor, task: TaskRow, project: ProjectRow, request: EpicDecisionRequest, runId: string, actor: Actor): Promise<void> {
  const operation = await activeResolution(tx, task.id)
  if (!operation) return
  const decision: EpicRebaseDecision = { ...request, id: randomUUID(), runId, raisedAt: new Date().toISOString(), answer: null }
  await tx.update(operations).set({ decisions: [...operation.decisions, decision], updatedAt: new Date() }).where(eq(operations.id, operation.id))
  await appendAudit(tx, { projectId: project.id, taskId: task.id, actor }, auditEvent('epic.pr', { epicId: operation.epicId, event: 'decision_requested', operationId: operation.id, decisionId: decision.id, summary: request.question, bindingDecision: request.bindingDecision ?? null, alternatives: request.alternatives.map(a => a.label), affectedChanges: request.affectedChanges }))
}

// The human's answer resumes the same operation: its candidate, its lock, and
// its task, back with the developer with the answer pinned. The answer stays on
// the journal, where the publish step reads what it means for approval.
export async function answerDecision(db: Executor, taskId: string, input: Extract<InboxActionInput, { action: 'decide' }>, actor: Actor): Promise<string> {
  return db.transaction(async (tx) => {
    const { task, project } = await lockTask(tx, taskId)
    const operation = await activeResolution(tx, taskId)
    const decision = operation && waitingOn(operation, task)
    if (!operation || !decision) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_decision_changed' })
    const answer = answerOn(decision, input)
    const { label } = answer
    const choice = input.alternative === undefined ? null : decision.alternatives[input.alternative]
    await tx.update(operations).set({ decisions: operation.decisions.map(d => d.id === decision.id ? { ...d, answer } : d), updatedAt: new Date() }).where(eq(operations.id, operation.id))
    const body = [`Decision on "${decision.question}": ${choice ? `${choice.label}. ${choice.effect}` : ''}`.trim(), input.text].filter(Boolean).join('\n\n')
    await addComment(tx, taskId, { body, pinned: true }, actor)
    await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('epic.pr', { epicId: operation.epicId, event: 'decision_answered', operationId: operation.id, decisionId: decision.id, summary: `${decision.question} ${label}${input.text ? `: ${input.text}` : ''}`, changesBehaviour: answer.changesBehaviour }))
    await applyTransition(tx, task, project, { type: 'resolve', to: 'in_progress' }, actor, { event: { type: 'resolve', to: 'in_progress' } })
    return operation.epicId
  })
}

// The question a Blocked resolution task is waiting on, for the Inbox
// waitingDecision for many tasks at once, holding only those that are waiting
export async function waitingDecisions(db: Executor, taskIds: string[]): Promise<Map<string, EpicRebaseDecision>> {
  if (taskIds.length === 0) return new Map()
  const rows = await db.select({ taskId: tasks.id, decisions: operations.decisions, status: tasks.status, statusReason: tasks.statusReason }).from(operations)
    .innerJoin(tasks, eq(tasks.id, operations.resolutionTaskId))
    .where(and(inArray(operations.resolutionTaskId, taskIds), inArray(operations.state, [...ACTIVE_OPERATION])))
  return new Map(rows.flatMap((row) => {
    const decision = waitingOn(row, row)
    return decision ? [[row.taskId, decision] as const] : []
  }))
}

export async function waitingDecision(db: Executor, taskId: string): Promise<EpicRebaseDecision | null> {
  const [row] = await db.select({ decisions: operations.decisions, status: tasks.status, statusReason: tasks.statusReason }).from(operations)
    .innerJoin(tasks, eq(tasks.id, operations.resolutionTaskId))
    .where(and(eq(operations.resolutionTaskId, taskId), inArray(operations.state, [...ACTIVE_OPERATION])))
  return row ? waitingOn(row, row) : null
}

// What the reviewer of a resolution is told, from the journal
export async function resolutionContext(db: Executor, taskId: string, epicId: string) {
  const [operation] = await db.select().from(operations).where(and(eq(operations.resolutionTaskId, taskId), inArray(operations.state, [...ACTIVE_OPERATION])))
  if (!operation) return null
  const [epic] = await db.select().from(epics).where(eq(epics.id, epicId))
  return {
    oldHead: operation.expectedTargetSha,
    ontoSha: operation.ontoSha!,
    conflictFiles: operation.conflictFiles ?? [],
    approvedHeadSha: APPROVED_STATES.includes(epic?.reviewState ?? null) ? epic?.approvedHeadSha ?? null : null,
    decisions: operation.decisions.filter(d => d.answer).map(d => ({ question: d.question, answer: [d.answer!.label, d.answer!.text].filter(Boolean).join(': ') }))
  }
}

// An epic's rebase that met a conflict and was left for its final checkpoint
// (COR-445). It's pending while nothing newer has rebased or fixed the epic, so
// the journal alone says so, and any later rebase clears it.
export const CONFLICT_DEFERRED = 'Conflict left for the final checkpoint'

export async function deferredConflicts(db: Executor, epicIds: string[]) {
  if (epicIds.length === 0) return new Map<string, typeof operations.$inferSelect>()
  const newest = await db.selectDistinctOn([operations.epicId]).from(operations)
    .where(and(inArray(operations.epicId, epicIds), eq(operations.kind, 'rebase')))
    .orderBy(operations.epicId, desc(operations.leaseEpoch))
  return new Map(newest.filter(o => o.error === CONFLICT_DEFERRED).map(o => [o.epicId, o]))
}
