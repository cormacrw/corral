import type { Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, desc, eq, sql } from 'drizzle-orm'
import type { ChangedFile, GitHubClient } from './github.ts'
import { appendAudit, auditEvent, type RebaseCheckFailure } from './audit.ts'
import { applyTransition, type ProjectRow, type TaskRow } from './tasks.ts'

const { acceptanceCriteria, auditLog, reviews } = schema

export type { RebaseCheckFailure }

function isProjectDoc(path: string): boolean {
  return path === 'CORRAL.md' || path === 'CLAUDE.md' || path.startsWith('docs/') || path.startsWith('.corral/wiki/')
}

// What a file's entry in a diff changes, or null when that can't be told. The
// base moving shifts line numbers without changing the change, so hunk headers
// don't count. Binary and very large files have no patch, and the blob on the
// head side says nothing about what it replaced: A → C and B → C share it. Only
// an added file replaced nothing, so only there does the blob identify the change.
function changeOf(file: ChangedFile): string | null {
  const change = file.patch?.replace(/^@@ .*$/gm, '@@') ?? (file.status === 'added' ? file.sha : null)
  return change === null ? null : JSON.stringify([file.status, file.previousFilename ?? null, change])
}

export interface TrivialRebaseCheck {
  failures: RebaseCheckFailure[]
  // Set when the check couldn't run, so it proved nothing
  error?: string
}

// D24's server check of a developer's `trivial`. Old and new base are the
// merge bases of the approved and new heads with the base branch, so nothing
// here rests on the developer's word except the list it's checked against.
export async function checkTrivialRebase(
  github: GitHubClient,
  repository: string,
  input: { baseBranch: string, approvedHeadSha: string, newHeadSha: string, conflictedFiles: string[] }
): Promise<TrivialRebaseCheck> {
  try {
    const baseHead = await github.branchHead(repository, input.baseBranch)
    if (!baseHead) throw new Error(`Branch ${input.baseBranch} doesn't exist`)
    const approved = await github.compare(repository, baseHead, input.approvedHeadSha)
    const rebased = await github.compare(repository, baseHead, input.newHeadSha)
    const onBase = await github.compare(repository, approved.mergeBase, rebased.mergeBase)

    const before = new Map(approved.files.map(f => [f.filename, changeOf(f)]))
    const after = new Map(rebased.files.map(f => [f.filename, changeOf(f)]))
    const outside = [...new Set([...before.keys(), ...after.keys()])]
      .filter((file) => {
        const change = before.get(file)
        return (change === null || change !== after.get(file)) && !input.conflictedFiles.includes(file)
      })
    const docs = [...new Set(onBase.files.flatMap(f => [f.filename, f.previousFilename ?? f.filename]))].filter(isProjectDoc)

    const failures: RebaseCheckFailure[] = []
    if (outside.length > 0) failures.push({ condition: 'changes_outside_conflicts', files: outside.sort() })
    if (docs.length > 0) failures.push({ condition: 'project_docs_changed', files: docs.sort() })
    return { failures }
  } catch (error) {
    console.error(`Trivial rebase check for ${input.newHeadSha} failed`, error)
    return { failures: [], error: error instanceof Error ? error.message : String(error) }
  }
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
// a criterion checked by a human stays open and does (D28), unless it's a
// PR-free task, whose open checks wait for the epic's approval (D27).
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
  await appendAudit(tx, { projectId: project.id, taskId: task.id, actor: input.actor }, auditEvent('review.recorded', { runId, verdict: 'approved', headSha, round: task.reviewRounds, met: kept.filter(v => v?.met).length, of: criteria.length, carriedFrom: task.approvedHeadSha }))
  await applyTransition(tx, task, project, { type: 'approval_carried', humanCheckOpen: task.integrationProtocol === 0 && kept.some(v => v?.met === null) }, { kind: 'system', component: 'server' }, { event: 'approval_carried', runId, headSha })
  return { ok: true }
}
