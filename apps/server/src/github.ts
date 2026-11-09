import type { CheckConclusion, PullRequestFile } from '@corral/contracts'
import type { GateCheck, MergeMethod } from '@corral/core'

export interface PullRequest {
  number: number
  // GraphQL node id, for mutations that take a PR id (updateBranch)
  nodeId: string
  url: string
  state: 'open' | 'closed'
  merged: boolean
  mergeCommitSha: string | null
  headSha: string
  // null while GitHub is still computing it
  mergeable: boolean | null
  // e.g. 'behind' when the base branch has moved on (R7)
  mergeableState: string | null
}

// A PR as a reader sees it, with up to `fileLimit` of its changed files
interface PullRequestDiff {
  number: number
  url: string
  title: string
  body: string
  baseBranch: string
  headBranch: string
  headSha: string
  changedFiles: number
  files: PullRequestFile[]
}

export interface CheckResult {
  name: string
  // 'pending' until it finishes
  conclusion: CheckConclusion
  url: string | null
}

// One file in a comparison. GitHub leaves `patch` out for binary and very
// large files; `sha` is the file's blob on the head side.
export interface ChangedFile {
  filename: string
  previousFilename?: string
  status: string
  sha: string
  additions: number
  deletions: number
  patch?: string
}

export interface Comparison {
  mergeBase: string
  files: ChangedFile[]
}

// The server's view of GitHub (D8: only the server decides PR, CI and merge
// actions). The real implementation sends each call through the runner's
// `gh` (R15); tests use FakeGitHub.
export interface GitHubClient {
  createBranch(repository: string, branch: string, sha: string): Promise<void>
  branchHead(repository: string, branch: string): Promise<string | null>
  findOpenPullRequest(repository: string, branch: string): Promise<PullRequest | null>
  openPullRequest(repository: string, input: { head: string, base: string, title: string, body: string }): Promise<PullRequest>
  updatePullRequest(repository: string, number: number, input: { title?: string, body?: string }): Promise<void>
  getPullRequest(repository: string, number: number): Promise<PullRequest>
  getPullRequestDiff(repository: string, number: number, fileLimit: number): Promise<PullRequestDiff>
  checks(repository: string, sha: string): Promise<CheckResult[]>
  // A failed check's failed step and raw log, the end of it when long, with
  // the failure lines the runner found in the whole of it. Throws when GitHub
  // has neither step nor log to give.
  ciFailure(repository: string, check: GateCheck): Promise<{ step: string | null, log: string, failureLines?: string[] }>
  // How many commits on `base` the commit `head` doesn't have
  behindBy(repository: string, base: string, head: string): Promise<number>
  // Three-dot compare: the changes from the merge base of the two commits to
  // `head`. Throws when GitHub can't give the complete file list.
  compare(repository: string, base: string, head: string): Promise<Comparison>
  // Rebases the PR branch onto its base on GitHub (never merges the base
  // in); false on a conflict or when GitHub can't update it
  updateBranch(repository: string, pr: { number: number, nodeId: string }, expectedHeadSha: string): Promise<boolean>
  merge(repository: string, number: number, method: MergeMethod, expectedHeadSha: string): Promise<{ merged: boolean, sha: string | null, message: string }>
  closePullRequest(repository: string, number: number): Promise<void>
  deleteBranch(repository: string, branch: string): Promise<void>
}

// What the merge gate reads from GitHub
export type GateReads = Pick<GitHubClient, 'getPullRequest' | 'checks'>

// Overlapping reads of one PR share a call; each still reads GitHub live
// (design/pull-requests.md). For pages that refetch on every task event and on
// a timer, so their requests overlap.
export class SharedReads implements GateReads {
  #github: GateReads
  #reads = new Map<string, Promise<unknown>>()

  constructor(github: GateReads) {
    this.#github = github
  }

  getPullRequest(repository: string, number: number): ReturnType<GitHubClient['getPullRequest']> {
    return this.#read(`pr ${repository} ${number}`, () => this.#github.getPullRequest(repository, number))
  }

  checks(repository: string, sha: string): ReturnType<GitHubClient['checks']> {
    return this.#read(`checks ${repository} ${sha}`, () => this.#github.checks(repository, sha))
  }

  #read<T>(key: string, load: () => Promise<T>): Promise<T> {
    const shared = this.#reads.get(key)
    if (shared) return shared as Promise<T>
    const value = load().finally(() => this.#reads.delete(key))
    this.#reads.set(key, value)
    return value
  }
}

export class GitHubError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

// Whether a failed call says nothing about what was asked: a 5xx, a rate limit,
// a runner that dropped off, a job timeout. Only a real answer from GitHub
// counts against a task; anything else is worth trying again later. A wrapped
// error is judged by its cause.
export function isTransient(error: unknown): boolean {
  if (error instanceof Error && error.cause !== undefined) return isTransient(error.cause)
  if (!(error instanceof GitHubError)) return true
  return error.status >= 500 || error.status === 429 || (error.status === 403 && /rate limit/i.test(error.message))
}

// GitHub also says `copied`, `changed` and `unchanged`
export function toFileStatus(status: string): PullRequestFile['status'] {
  if (status === 'added' || status === 'removed' || status === 'renamed') return status
  return status === 'copied' ? 'added' : 'modified'
}
