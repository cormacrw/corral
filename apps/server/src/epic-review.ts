import type { EpicReview, EpicReviewFeedback, EpicReviewRound, EpicReviewTask, EpicPrEvent, PullRequestFile } from '@corral/contracts'
import { isPrFree, isTaskDone } from '@corral/core'
import { schema, type EpicRow, type Executor, type ProjectRow, type TaskRow } from '@corral/db'
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm'
import { auditText, readAudit } from './audit.ts'
import { checkRows } from './checks.ts'
import { ApiFailure } from './errors.ts'
import { findEpic } from './epics.ts'
import { GitHubError, toFileStatus, type ChangedFile, type GitHubClient } from './github.ts'
import { compareUrl } from './github-urls.ts'
import { deferredConflicts } from './operations.ts'
import { epicBoard } from './parents.ts'
import { capDiff, readPullRequest } from './pull-requests.ts'
import { listEvidenceFor } from './runs.ts'
import { toTasks } from './task-views.ts'
import { CRITERIA_ORDER } from './criteria.ts'

// A task's integration review as people and its reviewer read it (D23, D27):
// its board with evidence, the human checks it owes, its rounds and feedback

const { acceptanceCriteria, agents, auditLog, epicReviewRounds, reviews } = schema

// The audit event of the human asking for changes on the task's PR
export const CHANGES_EVENT = 'human_changes_requested' satisfies EpicPrEvent

// What an integration review that gave up says, when its run left nothing better
export const REVIEW_FAILED = 'Integration review failed'

export function humanCriteria(db: Executor, board: TaskRow[]) {
  if (board.length === 0) return Promise.resolve([])
  return db.select({ id: acceptanceCriteria.id, taskId: acceptanceCriteria.taskId, text: acceptanceCriteria.text }).from(acceptanceCriteria)
    .where(and(inArray(acceptanceCriteria.taskId, board.map(t => t.id)), eq(acceptanceCriteria.checkedByHuman, true))).orderBy(...CRITERIA_ORDER)
}

// What each PR-free task leaves for the epic's human approval. Task-PR tasks
// had human review on their own path. Agent approval can't stand in (D28).
export async function humanObligations(db: Executor, board: TaskRow[]) {
  const criteria = await humanCriteria(db, board)
  return board.filter(t => isPrFree(t)).map(t => ({ taskId: t.id, humanReview: t.humanReview, humanChecks: criteria.filter(c => c.taskId === t.id).map(c => c.id) }))
}

export async function epicReviewContext(db: Executor, epic: EpicRow, project: ProjectRow) {
  const rows = await epicBoard(db, epic.id)
  return { epicId: epic.id, title: epic.title, goal: epic.description, branch: epic.branch, headSha: epic.prHeadSha,
    tasks: (await boardsWithEvidence(db, [{ project, rows }]))[0]! }
}

export type EpicBoard = EpicReviewTask[]

// API tasks with their evidence and human obligations for several boards at
// once, one per input
export async function boardsWithEvidence(db: Executor, boards: { project: ProjectRow, rows: TaskRow[] }[]): Promise<EpicBoard[]> {
  const [built, required] = await Promise.all([
    Promise.all(boards.map(({ project, rows }) => toTasks(db, project, rows))),
    humanObligations(db, boards.flatMap(b => b.rows))
  ])
  const evidence = await listEvidenceFor(db, built.flat().map(t => t.id))
  const owedOf = new Map(required.map(r => [r.taskId, r]))
  return built.map(board => board.map((task) => {
    const owed = owedOf.get(task.id)
    return { task, evidence: evidence.get(task.id) ?? [], humanReview: owed?.humanReview ?? false, humanChecks: owed?.humanChecks ?? [] }
  }))
}

// The human's latest request for changes on the epic PR, if any. Its detail
// is a snapshot; older records have no fix task links.
async function lastChangesRequest(db: Executor, epicId: string) {
  const [action] = await db.select({ detail: auditLog.detail, createdAt: auditLog.createdAt }).from(auditLog)
    .where(and(eq(auditLog.action, 'epic.pr'), sql`${auditText('epic.pr', 'epicId')} = ${epicId}`, sql`${auditText('epic.pr', 'event')} = ${CHANGES_EVENT}`))
    .orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(1)
  return action
}

export async function listEpicRounds(db: Executor, epicId: string): Promise<EpicReviewRound[]> {
  const rounds = await db.select({ review: epicReviewRounds, reviewer: { id: agents.id, name: agents.name } })
    .from(epicReviewRounds).innerJoin(agents, eq(agents.id, epicReviewRounds.reviewerId))
    .where(eq(epicReviewRounds.epicId, epicId)).orderBy(asc(epicReviewRounds.round))
  return rounds.map(({ review: r, reviewer }) => ({
    round: r.round, verdict: r.verdict, reviewer, headSha: r.headSha,
    summary: r.summary, findings: r.findings, at: r.createdAt.toISOString()
  }))
}

// A task's PR that integration review has yet to take up: none opened yet,
// or one left open or waiting for its fix work
export function awaitsReview(epic: Pick<EpicRow, 'prNumber' | 'reviewState'>): boolean {
  return !epic.prNumber || epic.reviewState === 'open' || epic.reviewState === 'changes_requested'
}

// What was approved, and where it sat. The base only informs the history, so
// failing to read it doesn't refuse the approval.
export async function approvalSnapshot(github: GitHubClient, project: ProjectRow, headSha: string) {
  const comparison = await github.compare(project.repository, project.defaultBranch, headSha).catch(() => null)
  return { approvedHeadSha: headSha, approvedBaseSha: comparison?.mergeBase ?? null }
}

const toFile = (file: ChangedFile): PullRequestFile => ({
  path: file.filename, status: toFileStatus(file.status), additions: file.additions, deletions: file.deletions, patch: file.patch ?? ''
})

// What a file's patch adds and removes. Context moves with the target branch,
// so it can't say whether the epic's own change did.
function changedLines(file: ChangedFile): string | null {
  const lines = file.patch?.split('\n').filter(line => /^[+-]/.test(line))
  const change = lines ?? (file.status === 'added' ? [file.sha] : null)
  return change === null ? null : JSON.stringify([file.status, file.previousFilename ?? null, change])
}

// The files that differ between two heads of the epic branch. Comparing them
// directly only works while one descends from the other: after a rebase it
// would also list everything from their merge base, so each head's own change
// against the target branch is compared instead, as a trivial rebase check does.
async function filesBetween(github: GitHubClient, project: ProjectRow, reviewedSha: string, headSha: string): Promise<PullRequestFile[]> {
  if (reviewedSha === headSha) return []
  const direct = await github.compare(project.repository, reviewedSha, headSha)
  if (direct.mergeBase === reviewedSha) return direct.files.map(toFile)
  const [before, after] = await Promise.all([
    github.compare(project.repository, project.defaultBranch, reviewedSha),
    github.compare(project.repository, project.defaultBranch, headSha)
  ])
  const reviewed = new Map(before.files.map(f => [f.filename, changedLines(f)]))
  const current = new Set(after.files.map(f => f.filename))
  return [
    ...after.files.filter((f) => {
      const change = changedLines(f)
      return change === null || change !== reviewed.get(f.filename)
    }).map(toFile),
    // Reverted: on the reviewed head, and nowhere in the epic's change now
    ...before.files.filter(f => !current.has(f.filename)).map(f => ({ ...toFile(f), status: 'removed' as const, patch: '' }))
  ]
}

async function lastFeedback(db: Executor, github: GitHubClient, project: ProjectRow, epicId: string, headSha: string | null): Promise<EpicReviewFeedback | null> {
  const action = await lastChangesRequest(db, epicId)
  if (!action) return null
  const { summary, fixTasks, headSha: reviewedSha } = readAudit(action.detail)
  const feedback = { text: summary ?? '', at: action.createdAt.toISOString(), headSha: reviewedSha ?? null, fixTasks: fixTasks ?? [] }
  if (!reviewedSha || !headSha) return { ...feedback, files: [], totalFiles: 0, truncated: false, diffUrl: null }
  const diffUrl = compareUrl(project.repository, reviewedSha, headSha)
  try {
    return { ...feedback, ...capDiff(await filesBetween(github, project, reviewedSha, headSha)), diffUrl }
  } catch (error) {
    // A force-push can leave the reviewed head unreachable, and a big enough
    // diff has no complete file list. The rest of the review still stands.
    if (!(error instanceof GitHubError)) throw error
    return { ...feedback, files: [], totalFiles: 0, truncated: true, diffUrl }
  }
}

// Approving a task in Human review writes no `reviews` row, only this audit
// entry. A design's approval is the same event.
async function humanApproved(db: Executor, taskIds: string[]): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set()
  const rows = await db.select({ taskId: auditLog.taskId }).from(auditLog)
    .where(and(inArray(auditLog.taskId, taskIds), eq(auditLog.action, 'task.transition'), sql`${auditText('task.transition', 'event')} = 'human_approve'`))
  return new Set(rows.map(r => r.taskId!))
}

async function agentApproved(db: Executor, taskIds: string[]): Promise<Set<string>> {
  if (taskIds.length === 0) return new Set()
  const rows = await db.select({ taskId: reviews.taskId }).from(reviews)
    .where(and(inArray(reviews.taskId, taskIds), eq(reviews.verdict, 'approved')))
  return new Set(rows.map(r => r.taskId))
}

// Live from GitHub, so it answers 503 with the runner offline and passes on
// `readPullRequest`'s errors. Nothing here is stored or changed.
export async function getEpicReview(db: Executor, github: GitHubClient, epicId: string): Promise<EpicReview> {
  const { row: epic, project } = await findEpic(db, epicId)
  if (epic.reviewMode === 'direct') {
    throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: 'This task merges its subtasks straight to the target branch, so it has no task review' }] })
  }
  const { tasks: board } = await epicReviewContext(db, epic, project)
  const ids = board.map(({ task }) => task.id)
  const [seen, passed] = await Promise.all([humanApproved(db, ids), agentApproved(db, ids)])
  const headSha = epic.prHeadSha
  const head = headSha ?? epic.branch
  const [pr, checks, targetMovedBy, rounds, feedback, deferred] = await Promise.all([
    epic.prNumber ? readPullRequest(github, project, epic.prNumber) : null,
    // A failed read of either leaves that part out, not the whole review
    headSha ? github.checks(project.repository, headSha).catch(() => []) : [],
    // Once merged the target has the work, and a squash leaves the old head behind
    head && epic.reviewState !== 'merged' ? github.behindBy(project.repository, project.defaultBranch, head).catch(() => null) : 0,
    listEpicRounds(db, epic.id),
    lastFeedback(db, github, project, epic.id, headSha),
    deferredConflicts(db, [epic.id])
  ])
  return {
    epicId: epic.id, title: epic.title, goal: epic.description, reviewMode: epic.reviewMode, state: epic.reviewState,
    targetBranch: project.defaultBranch, headSha, pr, gateChecks: checkRows(project.requiredChecks, checks), targetMovedBy,
    rounds: rounds.reverse(),
    tasks: board.map(({ task, evidence, humanReview, humanChecks }) => {
      const human = seen.has(task.id)
      return {
        id: task.id, ref: task.ref, title: task.title, kind: task.kind, merged: isTaskDone(task),
        prNumber: task.pr?.number ?? null, prUrl: task.pr?.url ?? null, integratedCommit: task.submission?.integrated ?? null,
        reviewedBy: human ? 'human' : passed.has(task.id) ? 'reviewer' : null,
        criteria: task.acceptanceCriteria,
        // A human check has no verdict; the human's approval of the task covers it
        criteriaMet: task.acceptanceCriteria.filter(c => c.met === true || (human && c.checkedByHuman)).length,
        criteriaTotal: task.acceptanceCriteria.length,
        evidence, humanReview, humanChecks
      }
    }),
    seenByHuman: ids.filter(id => seen.has(id)).length,
    lastFeedback: feedback,
    conflictPending: deferred.has(epic.id) && epic.reviewState !== 'merged',
    mergeCommitSha: epic.mergeCommitSha
  }
}
