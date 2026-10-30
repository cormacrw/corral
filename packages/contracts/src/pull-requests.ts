import type { MergeGate, ReviewVerdict, TaskStatus } from '@corral/core'

// ── Pull requests ───────────────────────────────────────────────────────────

// A task's open PR and where it stands against the merge gates, read live
// from GitHub (GET /projects/:slug/pull-requests). `merge` comes from the
// same gate check the merge orchestrator runs before it merges.
export interface PullRequestStatus {
  taskRef: string
  taskTitle: string
  taskStatus: TaskStatus
  pr: { number: number, url: string, state: 'open' | 'closed', headSha: string }
  // The latest verdict on the task, and whether it was for the PR's head
  review: { verdict: ReviewVerdict, headSha: string, forHeadCommit: boolean, createdAt: string } | null
  ci: {
    // Over the project's required checks: any failed, any not passed yet, or all passed
    status: 'passing' | 'failing' | 'pending'
    checks: { name: string, conclusion: CheckConclusion | 'missing', url: string | null }[]
  }
  branch: {
    name: string | null
    // null while GitHub is still computing it
    mergeable: boolean | null
    mergeableState: string | null
    upToDate: boolean
    // 'requested': Corral asked GitHub to update the branch onto the base;
    // 'needed': the base moved on and no update has been asked for yet;
    // 'conflict': GitHub can't merge it, so the developer has to rebase
    rebase: 'not_needed' | 'needed' | 'requested' | 'conflict'
  }
  evidenceComplete: boolean
  // The task is flagged for human review and the human hasn't approved it yet
  humanReviewOutstanding: boolean
  merge: {
    eligible: boolean
    // The first gate that failed, in the order core checks them
    failingGate: MergeGate | null
    failedGates: MergeGate[]
  }
}

export type CheckConclusion = 'success' | 'failure' | 'pending' | 'neutral' | 'skipped'
