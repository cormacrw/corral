import { PULL_REQUEST_FILE_LIMIT, PULL_REQUEST_LINE_LIMIT, type PullRequestDetail, type PullRequestFile, type PullRequestStatus } from '@corral/contracts'
import { errorText, failedMergeGates, humanReviewFlag, requiresHumanReview, taskRef } from '@corral/core'
import { schema, type Database, type ProjectRow } from '@corral/db'
import { and, asc, desc, eq, inArray, isNotNull, isNull, ne } from 'drizzle-orm'
import { checkRows, requiredChecks } from './checks.ts'
import { ApiFailure } from './errors.ts'
import { GitHubError, type GitHubClient } from './github.ts'
import type { MergeOrchestrator } from './merge.ts'

const { epics, reviews, tasks } = schema

// Gate checks run this many PRs at a time
const CONCURRENT_PULL_REQUESTS = 5

async function mapLimit<T, R>(items: T[], limit: number, map: (item: T) => Promise<R>): Promise<R[]> {
  const results = new Array<R>(items.length)
  const queue = items.entries()
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (const [i, item] of queue) results[i] = await map(item)
  }))
  return results
}

// Every task in the project with an open PR, and where it stands against the
// merge gates. The gate facts come from the merge orchestrator and the
// verdict from core's failedMergeGates, so this answers exactly as a merge
// attempt would; everything is read live from GitHub.
export async function listPullRequests(db: Database, merges: Pick<MergeOrchestrator, 'gates' | 'displayReads'>, project: ProjectRow): Promise<PullRequestStatus[]> {
  const rows = await db.select().from(tasks)
    .where(and(eq(tasks.projectId, project.id), isNotNull(tasks.prNumber), isNull(tasks.deletedAt), ne(tasks.status, 'merged')))
    .orderBy(asc(tasks.number))
  const latestReviews = rows.length > 0
    ? await db.selectDistinctOn([reviews.taskId], { taskId: reviews.taskId, verdict: reviews.verdict, headSha: reviews.headSha, createdAt: reviews.createdAt }).from(reviews)
        .where(inArray(reviews.taskId, rows.map(t => t.id))).orderBy(reviews.taskId, desc(reviews.createdAt))
    : []
  const reviewOf = new Map(latestReviews.map(r => [r.taskId, r]))
  const epicIds = [...new Set(rows.flatMap(t => t.epicId ? [t.epicId] : []))]
  const modes = new Map(epicIds.length > 0 ? (await db.select({ id: epics.id, reviewMode: epics.reviewMode }).from(epics).where(inArray(epics.id, epicIds))).map(e => [e.id, e.reviewMode]) : [])
  const statuses = await mapLimit(rows, CONCURRENT_PULL_REQUESTS, async (task): Promise<PullRequestStatus | null> => {
    const report = await merges.gates(task, project, undefined, merges.displayReads)
    const { pr } = report
    if (pr.state !== 'open' || pr.merged) return null
    const review = reviewOf.get(task.id)
    const checks = checkRows(project.requiredChecks, report.checks)
    const ci = requiredChecks(project.requiredChecks, report.checks)
    const failed = failedMergeGates(report.facts)
    return {
      taskRef: taskRef(project.prefix, task.number),
      taskTitle: task.title,
      taskStatus: task.status,
      pr: { number: pr.number, url: pr.url, state: pr.state, headSha: pr.headSha },
      review: review
        ? { verdict: review.verdict, headSha: review.headSha, forHeadCommit: review.headSha === pr.headSha, createdAt: review.createdAt.toISOString() }
        : null,
      // As the orchestrator reads CI: a failed required check sends the task
      // back; one that hasn't passed yet is waited on
      ci: {
        status: ci.failed.length > 0 ? 'failing' : ci.pending.length > 0 ? 'pending' : 'passing',
        checks
      },
      branch: {
        name: task.branch,
        mergeable: pr.mergeable,
        mergeableState: pr.mergeableState,
        upToDate: pr.mergeableState !== 'behind',
        rebase: pr.mergeableState === 'behind'
          ? (task.branchUpdateRequested ? 'requested' : 'needed')
          : pr.mergeable === false ? 'conflict' : 'not_needed'
      },
      evidenceComplete: report.facts.evidenceComplete,
      // Human review also covers tasks a human check sent there (D27)
      humanReviewOutstanding: task.status === 'human_review' || (requiresHumanReview(task.type, humanReviewFlag(task, task.epicId ? modes.get(task.epicId) ?? null : null)) && task.status !== 'ready_to_merge'),
      merge: { eligible: failed.length === 0, failingGate: failed[0] ?? null, failedGates: failed }
    }
  })
  return statuses.filter((s): s is PullRequestStatus => s !== null)
}

// A patch up to `lines` changed lines, ending on a whole line
function cutPatch(patch: string, lines: number): string {
  let changed = 0
  const all = patch.split('\n')
  const end = all.findIndex((line) => {
    if (line.startsWith('+') || line.startsWith('-')) changed++
    return changed > lines
  })
  return end === -1 ? patch : all.slice(0, end).join('\n')
}

// As many files as fit the line budget, in GitHub's order. The file that goes
// over it keeps the start of its patch, so a single huge file still shows
// something. Files with no changed lines, such as renames, cost nothing.
function capFiles(files: PullRequestFile[]): { files: PullRequestFile[], cut: boolean } {
  const kept: PullRequestFile[] = []
  let remaining = PULL_REQUEST_LINE_LIMIT
  for (const file of files) {
    const lines = file.additions + file.deletions
    if (lines > 0 && remaining === 0) return { files: kept, cut: true }
    if (lines > remaining) return { files: [...kept, { ...file, patch: cutPatch(file.patch, remaining) }], cut: true }
    kept.push(file)
    remaining -= lines
  }
  return { files: kept, cut: false }
}

// Any diff under the PR cap, in GitHub's order
export function capDiff(all: PullRequestFile[]): { files: PullRequestFile[], totalFiles: number, truncated: boolean } {
  const { files, cut } = capFiles(all.slice(0, PULL_REQUEST_FILE_LIMIT))
  return { files, totalFiles: all.length, truncated: cut || files.length < all.length }
}

// Any PR on the project's repository, not just a task's: the epic panel reads
// epic PRs through this too
export async function readPullRequest(github: GitHubClient, project: ProjectRow, number: number): Promise<PullRequestDetail> {
  try {
    const { changedFiles, ...pr } = await github.getPullRequestDiff(project.repository, number, PULL_REQUEST_FILE_LIMIT)
    const { files, cut } = capFiles(pr.files)
    return { ...pr, files, totalFiles: changedFiles, truncated: cut || files.length < changedFiles }
  } catch (error) {
    throw pullRequestUnavailable(error, number)
  }
}

// A PR GitHub can't return is an expected answer, not a server fault: a 404
// for one it doesn't have, a 502 otherwise. An API error, such as a runner
// that's offline, stays as it is.
export function pullRequestUnavailable(error: unknown, number: number): unknown {
  if (error instanceof ApiFailure) return error
  return new ApiFailure(error instanceof GitHubError && error.status === 404 ? 404 : 502, { code: 'pull_request_unavailable', number, message: errorText(error) })
}
