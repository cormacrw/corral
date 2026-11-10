import { isPrFree, SERVER_ACTOR, type Actor } from '@corral/core'
import { schema, type Executor, type ProjectRow, type TaskRow } from '@corral/db'
import { and, desc, eq, sql } from 'drizzle-orm'
import type { RebaseCheckFailure } from '@corral/contracts'
import { appendAudit, auditEvent } from './audit.ts'
import { applyTransition } from './tasks.ts'
import { taskCriteria } from './criteria.ts'

const { auditLog, reviews } = schema

type ReviewRow = typeof reviews.$inferSelect

// The check's result is recorded with the transition into Agent review, under
// the `pr_rebased` event; a run's own report holds what the developer said
export async function latestRebaseCheckFailures(db: Executor, taskId: string): Promise<RebaseCheckFailure[]> {
  const [row] = await db.select({ detail: auditLog.detail }).from(auditLog)
    .where(and(eq(auditLog.taskId, taskId), eq(auditLog.action, 'task.transition'), sql`${auditLog.detail}->>'event' = 'pr_rebased'`))
    .orderBy(desc(auditLog.createdAt)).limit(1)
  return (row?.detail as { checkFailures?: RebaseCheckFailure[] } | undefined)?.checkFailures ?? []
}

export async function latestApproval(db: Executor, taskId: string, headSha: string): Promise<ReviewRow | null> {
  const [row] = await db.select().from(reviews)
    .where(and(eq(reviews.taskId, taskId), eq(reviews.verdict, 'approved'), eq(reviews.headSha, headSha)))
    .orderBy(desc(reviews.createdAt)).limit(1)
  return row ?? null
}

// An approval carried to a new head is a review of that head, by Corral,
// saying where it came from. The base-update case keeps the reviewer's round
// and verdicts as they were; a rebase re-reads the criteria first.
export async function carryApproval(tx: Executor, task: Pick<TaskRow, 'id'>, approval: ReviewRow, to: { headSha: string, summary: string, round?: number, runId?: string, criteria?: ReviewRow['criteria'], author: Actor }): Promise<void> {
  await tx.insert(reviews).values({
    taskId: task.id,
    runId: to.runId ?? approval.runId,
    round: to.round ?? approval.round,
    headSha: to.headSha,
    verdict: 'approved',
    summary: to.summary,
    criteria: to.criteria ?? approval.criteria,
    author: to.author
  })
}

type CarryOver = { ok: true } | { ok: false, problem: string }

// D24: records a review on the new head with the last approval's criteria
// verdicts, then returns the task to Ready to merge. The human approved before
// the conflict, so humanReview and each_task epics don't send it back to them;
// a criterion checked by a human stays open and does (D28), unless it's a
// PR-free task, whose open checks wait for the epic's approval (D27).
// Call with the task locked and `headSha` on the new head; nothing is written
// when the approval can't carry over.
export async function carryOverApproval(
  tx: Executor,
  { task, project }: { task: TaskRow, project: ProjectRow },
  input: { actor: Actor, runId?: string, via: string, note: string }
): Promise<CarryOver> {
  const approval = await latestApproval(tx, task.id, task.approvedHeadSha!)
  if (!approval) return { ok: false, problem: 'No approval found for the previously approved head.' }

  const criteria = await taskCriteria(tx, task.id)
  const kept = criteria.map(c => c.checkedByHuman
    ? { criterionId: c.id, met: null, note: 'Needs human check' }
    : approval.criteria.find(v => v.criterionId === c.id))
  const stillApplies = approval.criteria.every(v => criteria.some(c => c.id === v.criterionId)) && kept.every(v => v && v.met !== false)
  if (!stillApplies) return { ok: false, problem: 'The earlier approval no longer covers every acceptance criterion.' }

  const headSha = task.headSha!
  const runId = input.runId ?? approval.runId
  await carryApproval(tx, task, approval, { headSha, runId, round: task.reviewRounds, summary: `Approval carried over ${input.via} from ${task.approvedHeadSha} to ${headSha}. ${input.note.trim()}`, criteria: kept.filter(v => v !== undefined), author: input.actor })
  await appendAudit(tx, { projectId: project.id, taskId: task.id, actor: input.actor }, auditEvent('review.recorded', { runId, verdict: 'approved', headSha, round: task.reviewRounds, met: kept.filter(v => v?.met).length, of: criteria.length, carriedFrom: task.approvedHeadSha }))
  await applyTransition(tx, task, project, { type: 'approval_carried', humanCheckOpen: !isPrFree(task) && kept.some(v => v?.met === null) }, SERVER_ACTOR, { event: 'approval_carried', runId, headSha })
  return { ok: true }
}
