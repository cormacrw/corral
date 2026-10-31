import { PULL_REQUEST_FILE_LIMIT, PULL_REQUEST_LINE_LIMIT, type PullRequestDetail, type PullRequestFile, type PullRequestStatus } from '@corral/contracts'
import { failedMergeGates, requiresHumanReview, taskRef } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, asc, desc, eq, isNotNull, isNull, ne } from 'drizzle-orm'
import { ApiFailure } from './errors.ts'
import { GitHubError, type GitHubClient } from './github.ts'
import type { MergeOrchestrator } from './merge.ts'
import type { ProjectRow } from './tasks.ts'

const { reviews, tasks } = schema

// Every task in the project with an open PR, and where it stands against the
// merge gates. The gate facts come from the merge orchestrator and the
// verdict from core's failedMergeGates, so this answers exactly as a merge
// attempt would; everything is read live from GitHub.
export async function listPullRequests(db: Database, merges: MergeOrchestrator, project: ProjectRow): Promise<PullRequestStatus[]> {
  const rows = await db.select().from(tasks)
    .where(and(eq(tasks.projectId, project.id), isNotNull(tasks.prNumber), isNull(tasks.deletedAt), ne(tasks.status, 'merged')))
    .orderBy(asc(tasks.number))
  const statuses = await Promise.all(rows.map(async (task): Promise<PullRequestStatus | null> => {
    const report = await merges.gates(task, project)
    const { pr } = report
    if (pr.state !== 'open' || pr.merged) return null
    const [review] = await db.select().from(reviews).where(eq(reviews.taskId, task.id)).orderBy(desc(reviews.createdAt)).limit(1)
    const checks = project.requiredChecks.map((name) => {
      const check = report.checks.find(c => c.name === name)
      return { name, conclusion: check?.conclusion ?? 'missing' as const, url: check?.url ?? null }
    })
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
        status: checks.some(c => c.conclusion === 'failure') ? 'failing' : checks.every(c => c.conclusion === 'success') ? 'passing' : 'pending',
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
      humanReviewOutstanding: task.status === 'human_review' || (requiresHumanReview(task.type, task.humanReview) && task.status !== 'ready_to_merge'),
      merge: { eligible: failed.length === 0, failingGate: failed[0] ?? null, failedGates: failed }
    }
  }))
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

// Any PR on the project's repository, not just a task's: the epic panel reads
// epic PRs through this too. Failures come back as API errors because a PR
// GitHub can't return is an expected answer here, not a server fault; a
// runner that's offline stays `runner_offline`.
export async function readPullRequest(github: GitHubClient, project: ProjectRow, number: number): Promise<PullRequestDetail> {
  try {
    const { changedFiles, ...pr } = await github.getPullRequestDiff(project.repository, number, PULL_REQUEST_FILE_LIMIT)
    const { files, cut } = capFiles(pr.files)
    return { ...pr, files, totalFiles: changedFiles, truncated: cut || files.length < changedFiles }
  } catch (error) {
    if (error instanceof ApiFailure) throw error
    const message = error instanceof Error ? error.message : String(error)
    throw new ApiFailure(error instanceof GitHubError && error.status === 404 ? 404 : 502, { code: 'pull_request_unavailable', number, message })
  }
}
