import type { Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import { applyTransition, type ProjectRow, type TaskRow } from './tasks.ts'

const { acceptanceCriteria, auditLog, reviews } = schema

// Which of D24's two conditions the server check found broken, and where
export interface RebaseCheckFailure {
  condition: 'changes_outside_conflicts' | 'project_docs_changed'
  files: string[]
}

// The check's result is recorded with the transition into Agent review, under
// the `pr_rebased` event; a run's own report holds what the developer said
export async function latestRebaseCheckFailures(db: Executor, taskId: string): Promise<RebaseCheckFailure[]> {
  const [row] = await db.select({ detail: auditLog.detail }).from(auditLog)
    .where(and(eq(auditLog.taskId, taskId), eq(auditLog.action, 'task.transition'), sql`${auditLog.detail}->>'event' = 'pr_rebased'`))
    .orderBy(desc(auditLog.createdAt)).limit(1)
  return (row?.detail as { checkFailures?: RebaseCheckFailure[] } | undefined)?.checkFailures ?? []
}

export type CarryOver = { ok: true } | { ok: false, problem: string }

// D24: records a review on the new head with the last approval's criteria
// verdicts, then returns the task to Ready to merge. The human approved before
// the conflict, so humanReview and each_task epics don't send it back to them;
// a criterion checked by a human stays open and does (D28).
// Call with the task locked and `headSha` on the new head; nothing is written
// when the approval can't carry over.
export async function carryOverApproval(
  tx: Executor,
  { task, project }: { task: TaskRow, project: ProjectRow },
  input: { actor: Actor, runId?: string, via: string, note: string }
): Promise<CarryOver> {
  const [approval] = await tx.select().from(reviews)
    .where(and(eq(reviews.taskId, task.id), eq(reviews.verdict, 'approved'), eq(reviews.headSha, task.approvedHeadSha!)))
    .orderBy(desc(reviews.createdAt)).limit(1)
  if (!approval) return { ok: false, problem: 'No approval found for the previously approved head.' }

  const criteria = await tx.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id)).orderBy(asc(acceptanceCriteria.position))
  const kept = criteria.map(c => c.checkedByHuman
    ? { criterionId: c.id, met: null, note: 'Needs human check' }
    : approval.criteria.find(v => v.criterionId === c.id))
  const stillApplies = approval.criteria.every(v => criteria.some(c => c.id === v.criterionId)) && kept.every(v => v && v.met !== false)
  if (!stillApplies) return { ok: false, problem: 'The earlier approval no longer covers every acceptance criterion.' }

  const headSha = task.headSha!
  const runId = input.runId ?? approval.runId
  await tx.insert(reviews).values({
    taskId: task.id,
    runId,
    round: task.reviewRounds,
    headSha,
    verdict: 'approved',
    summary: `Approval carried over ${input.via} from ${task.approvedHeadSha} to ${headSha}. ${input.note.trim()}`,
    criteria: kept.filter(v => v !== undefined),
    author: input.actor
  })
  await tx.insert(auditLog).values({
    projectId: project.id, taskId: task.id, actor: input.actor, action: 'review.recorded',
    detail: { runId, verdict: 'approved', headSha, round: task.reviewRounds, met: kept.filter(v => v?.met).length, of: criteria.length, carriedFrom: task.approvedHeadSha }
  })
  await applyTransition(tx, task, project, { type: 'approval_carried', humanCheckOpen: kept.some(v => v?.met === null) }, { kind: 'system', component: 'server' }, { event: 'approval_carried', runId, headSha })
  return { ok: true }
}
