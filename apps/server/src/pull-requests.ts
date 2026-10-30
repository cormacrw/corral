import type { PullRequestStatus } from '@corral/contracts'
import { failedMergeGates, requiresHumanReview, taskRef } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, asc, desc, eq, isNotNull, isNull, ne } from 'drizzle-orm'
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
