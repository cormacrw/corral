import type { EpicReview, EpicReviewFeedback, PullRequestFile } from '@corral/contracts'
import { isTaskDone } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, eq, inArray, sql } from 'drizzle-orm'
import { auditText, readAudit } from './audit.ts'
import { ApiFailure } from './errors.ts'
import { epicReviewContext, lastChangesRequest, listEpicRounds } from './epic-prs.ts'
import { findEpic } from './epics.ts'
import { GitHubError, toFileStatus, type ChangedFile, type GitHubClient } from './github.ts'
import { capDiff, readPullRequest, requiredChecks } from './pull-requests.ts'
import { changeOf } from './rebase-review.ts'
import type { ProjectRow } from './tasks.ts'

const { auditLog, reviews } = schema

const toFile = (file: ChangedFile): PullRequestFile => ({
  path: file.filename, status: toFileStatus(file.status), additions: file.additions, deletions: file.deletions, patch: file.patch ?? ''
})

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
  const reviewed = new Map(before.files.map(f => [f.filename, changeOf(f)]))
  const current = new Set(after.files.map(f => f.filename))
  return [
    ...after.files.filter((f) => {
      const change = changeOf(f)
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
  const diffUrl = `https://github.com/${project.repository}/compare/${reviewedSha}...${headSha}`
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
    throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: 'This epic merges its tasks straight to the target branch, so it has no epic review' }] })
  }
  const { tasks: board } = await epicReviewContext(db, epic, project)
  const ids = board.map(({ task }) => task.id)
  const [seen, passed] = await Promise.all([humanApproved(db, ids), agentApproved(db, ids)])
  const headSha = epic.prHeadSha
  const head = headSha ?? epic.branch
  const [pr, checks, targetMovedBy, rounds, feedback] = await Promise.all([
    epic.prNumber ? readPullRequest(github, project, epic.prNumber) : null,
    headSha ? github.checks(project.repository, headSha) : [],
    // Once merged the target has the work, and a squash leaves the old head behind
    head && epic.reviewState !== 'merged' ? github.behindBy(project.repository, project.defaultBranch, head) : 0,
    listEpicRounds(db, epic.id),
    lastFeedback(db, github, project, epic.id, headSha)
  ])
  return {
    epicId: epic.id, title: epic.title, goal: epic.description, reviewMode: epic.reviewMode, state: epic.reviewState,
    targetBranch: project.defaultBranch, headSha, pr, gateChecks: requiredChecks(project, checks), targetMovedBy,
    rounds: rounds.reverse(),
    tasks: board.map(({ task, evidence, humanReview, humanChecks }) => {
      const human = seen.has(task.id)
      return {
        id: task.id, ref: task.ref, title: task.title, kind: task.kind, merged: task.status === 'merged',
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
    conflictTaskRef: board.find(({ task }) => task.kind === 'conflict' && !isTaskDone(task))?.task.ref ?? null,
    mergeCommitSha: epic.mergeCommitSha
  }
}
