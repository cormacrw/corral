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

// A PR's description and diff, read live from GitHub for the Inbox's PR
// description and Code diff tabs. It works for any PR on the project's
// repository (GET /projects/:slug/pull-requests/:number) and for a task's own
// (GET /projects/:slug/tasks/:number/pull-request).
export interface PullRequestDetail {
  number: number
  url: string
  title: string
  // The PR description, as the developer wrote it (markdown)
  body: string
  baseBranch: string
  headBranch: string
  // Capped at PULL_REQUEST_FILE_LIMIT files and PULL_REQUEST_LINE_LIMIT changed
  // lines; the rest is on GitHub at `url`
  files: PullRequestFile[]
  // Files changed in the whole PR, including any left out of `files`
  totalFiles: number
  // Some of the diff was left out: whole files, or the end of the last file's patch
  truncated: boolean
}

export interface PullRequestFile {
  path: string
  status: 'added' | 'modified' | 'removed' | 'renamed'
  // The file's full counts, even when its patch was cut
  additions: number
  deletions: number
  // Empty when GitHub has no text diff for the file, e.g. a binary or a very large file
  patch: string
}

export const PULL_REQUEST_FILE_LIMIT = 20
export { PULL_REQUEST_LINE_LIMIT } from './client.ts'

export type CheckConclusion = 'success' | 'failure' | 'pending' | 'neutral' | 'skipped'
