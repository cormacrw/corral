import type { InboxActionInput } from '@corral/contracts'
import { ACTIVE_OPERATION_STATES, APPROVED_STATES, type Actor, type EpicDecisionRequest, type EpicRebaseDecision, type ResolutionReview } from '@corral/core'
import { schema, type Executor, type OperationRow, type ProjectRow, type TaskRow } from '@corral/db'
import { and, eq, inArray } from 'drizzle-orm'
import { addComment } from './comments.ts'
import { ApiFailure } from './errors.ts'
import { answerDecision as answerOperationDecision, answeredDecisions, raiseDecision as raiseOperationDecision, waitingOn } from './operations.ts'
import { lockTask } from './task-rows.ts'
import { applyTransition } from './tasks.ts'

// A resolution task from before D29: a rebase's conflict worked on as a task
// of its own, which the human's decisions block and unblock

const { epics, taskIntegrationOperations: operations, tasks } = schema

async function activeResolution(tx: Executor, taskId: string): Promise<OperationRow | null> {
  const [row] = await tx.select().from(operations).where(and(eq(operations.resolutionTaskId, taskId), inArray(operations.state, [...ACTIVE_OPERATION_STATES]))).for('update')
  return row ?? null
}

export async function recordResolutionReview(tx: Executor, taskId: string, review: ResolutionReview): Promise<void> {
  await tx.update(operations).set({ resolutionReview: review, updatedAt: new Date() }).where(and(eq(operations.resolutionTaskId, taskId), inArray(operations.state, [...ACTIVE_OPERATION_STATES])))
}

// Puts a question on the operation. The caller blocks the task with it.
export async function raiseDecision(tx: Executor, task: TaskRow, project: ProjectRow, request: EpicDecisionRequest, runId: string, actor: Actor): Promise<void> {
  const operation = await activeResolution(tx, task.id)
  if (operation) await raiseOperationDecision(tx, operation, request, runId, { projectId: project.id, taskId: task.id, actor })
}

// The human's answer resumes the same operation: its candidate, its lock, and
// its task, back with the developer with the answer pinned.
export async function answerDecision(db: Executor, taskId: string, input: Extract<InboxActionInput, { action: 'decide' }>, actor: Actor): Promise<string> {
  return db.transaction(async (tx) => {
    const { task, project } = await lockTask(tx, taskId)
    const operation = await activeResolution(tx, taskId)
    const decision = operation && waitingOn(operation, task)
    if (!operation || !decision) throw new ApiFailure(409, { code: 'conflict', constraint: 'epic_decision_changed' })
    await answerOperationDecision(tx, operation, decision, input, { projectId: project.id, taskId, actor })
    const choice = input.alternative === undefined ? null : decision.alternatives[input.alternative]
    const body = [`Decision on "${decision.question}": ${choice ? `${choice.label}. ${choice.effect}` : ''}`.trim(), input.text].filter(Boolean).join('\n\n')
    await addComment(tx, taskId, { body, pinned: true }, actor)
    await applyTransition(tx, task, project, { type: 'resolve', to: 'in_progress' }, actor, { event: { type: 'resolve', to: 'in_progress' } })
    return operation.epicId
  })
}

// The question each Blocked resolution task is waiting on, for the Inbox,
// holding only those that are waiting
export async function waitingDecisions(db: Executor, taskIds: string[]): Promise<Map<string, EpicRebaseDecision>> {
  if (taskIds.length === 0) return new Map()
  const rows = await db.select({ taskId: tasks.id, decisions: operations.decisions, status: tasks.status, statusReason: tasks.statusReason }).from(operations)
    .innerJoin(tasks, eq(tasks.id, operations.resolutionTaskId))
    .where(and(inArray(operations.resolutionTaskId, taskIds), inArray(operations.state, [...ACTIVE_OPERATION_STATES])))
  return new Map(rows.flatMap((row) => {
    const decision = waitingOn(row, row)
    return decision ? [[row.taskId, decision] as const] : []
  }))
}

export async function waitingDecision(db: Executor, taskId: string): Promise<EpicRebaseDecision | null> {
  return (await waitingDecisions(db, [taskId])).get(taskId) ?? null
}

// What the reviewer of a resolution is told, from the journal
export async function resolutionContext(db: Executor, taskId: string, epicId: string) {
  const [operation] = await db.select().from(operations).where(and(eq(operations.resolutionTaskId, taskId), inArray(operations.state, [...ACTIVE_OPERATION_STATES])))
  if (!operation) return null
  const [epic] = await db.select().from(epics).where(eq(epics.id, epicId))
  return {
    oldHead: operation.expectedTargetSha,
    ontoSha: operation.ontoSha!,
    conflictFiles: operation.conflictFiles ?? [],
    approvedHeadSha: APPROVED_STATES.includes(epic?.reviewState ?? null) ? epic?.approvedHeadSha ?? null : null,
    decisions: answeredDecisions(operation)
  }
}
