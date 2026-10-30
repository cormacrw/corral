import type { MergeMethod } from '@corral/core'
import type { RunnerHub } from './runner-hub.ts'

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

export interface CheckResult {
  name: string
  // 'pending' until it finishes
  conclusion: 'success' | 'failure' | 'pending' | 'neutral' | 'skipped'
  url: string | null
}

// One file in a comparison. GitHub leaves `patch` out for binary and very
// large files; `sha` is the file's blob on the head side.
export interface ChangedFile {
  filename: string
  previousFilename?: string
  status: string
  sha: string
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
  checks(repository: string, sha: string): Promise<CheckResult[]>
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

export class GitHubError extends Error {
  readonly status: number
  constructor(status: number, message: string) {
    super(message)
    this.status = status
  }
}

interface RawPull {
  number: number
  node_id: string
  html_url: string
  state: 'open' | 'closed'
  merged?: boolean
  merged_at?: string | null
  merge_commit_sha: string | null
  head: { sha: string }
  mergeable?: boolean | null
  mergeable_state?: string | null
}

function toPullRequest(raw: RawPull): PullRequest {
  return {
    number: raw.number,
    nodeId: raw.node_id,
    url: raw.html_url,
    state: raw.state,
    merged: Boolean(raw.merged ?? raw.merged_at),
    mergeCommitSha: raw.merge_commit_sha,
    headSha: raw.head.sha,
    mergeable: raw.mergeable ?? null,
    mergeableState: raw.mergeable_state ?? null
  }
}

interface RawChangedFile {
  filename: string
  previous_filename?: string
  status: string
  sha: string
  patch?: string
}

// GitHub lists at most this many files in a comparison, without saying it cut
// the list short
const MAX_COMPARE_FILES = 300

interface GraphQLError {
  type?: string
  message: string
}

const UPDATE_BRANCH_MUTATION = `mutation($pullRequestId: ID!, $expectedHeadOid: GitObjectID!) {
  updatePullRequestBranch(input: { pullRequestId: $pullRequestId, expectedHeadOid: $expectedHeadOid, updateMethod: REBASE }) {
    pullRequest { headRefOid }
  }
}`

export class RunnerGitHub implements GitHubClient {
  #runner: RunnerHub

  constructor(runner: RunnerHub) {
    this.#runner = runner
  }

  async #call(method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown, ok: number[] = [200, 201]) {
    const result = await this.#runner.request({ kind: 'github', method, path, ...(body !== undefined && { body }) })
    if (!ok.includes(result.status)) {
      const message = (result.body as { message?: string } | null)?.message ?? `GitHub ${method} ${path} returned ${result.status}`
      throw new GitHubError(result.status, message)
    }
    return result
  }

  async createBranch(repository: string, branch: string, sha: string): Promise<void> {
    try {
      await this.#call('POST', `/repos/${repository}/git/refs`, { ref: `refs/heads/${branch}`, sha })
    } catch (error) {
      // Another claim may have created the same epic branch first.
      if (!(error instanceof GitHubError) || error.status !== 422 || !await this.branchHead(repository, branch)) throw error
    }
  }

  async branchHead(repository: string, branch: string) {
    const result = await this.#call('GET', `/repos/${repository}/git/ref/heads/${encodeURIComponent(branch)}`, undefined, [200, 404])
    return result.status === 404 ? null : (result.body as { object: { sha: string } }).object.sha
  }

  async findOpenPullRequest(repository: string, branch: string) {
    const owner = repository.split('/')[0]
    const result = await this.#call('GET', `/repos/${repository}/pulls?state=open&head=${owner}:${encodeURIComponent(branch)}`)
    const [first] = result.body as RawPull[]
    return first ? toPullRequest(first) : null
  }

  async openPullRequest(repository: string, input: { head: string, base: string, title: string, body: string }) {
    return toPullRequest((await this.#call('POST', `/repos/${repository}/pulls`, input)).body as RawPull)
  }

  async updatePullRequest(repository: string, number: number, input: { title?: string, body?: string }) {
    await this.#call('PATCH', `/repos/${repository}/pulls/${number}`, input)
  }

  async getPullRequest(repository: string, number: number) {
    return toPullRequest((await this.#call('GET', `/repos/${repository}/pulls/${number}`)).body as RawPull)
  }

  async checks(repository: string, sha: string) {
    const runs = (await this.#call('GET', `/repos/${repository}/commits/${sha}/check-runs?per_page=100`)).body as {
      check_runs: { name: string, status: string, conclusion: string | null, html_url: string | null }[]
    }
    const statuses = (await this.#call('GET', `/repos/${repository}/commits/${sha}/status`)).body as {
      statuses: { context: string, state: string, target_url: string | null }[]
    }
    return [
      ...runs.check_runs.map((run): CheckResult => ({
        name: run.name,
        conclusion: run.status !== 'completed'
          ? 'pending'
          : run.conclusion === 'success' ? 'success' : run.conclusion === 'neutral' ? 'neutral' : run.conclusion === 'skipped' ? 'skipped' : 'failure',
        url: run.html_url
      })),
      ...statuses.statuses.map((status): CheckResult => ({
        name: status.context,
        conclusion: status.state === 'success' ? 'success' : status.state === 'pending' ? 'pending' : 'failure',
        url: status.target_url
      }))
    ]
  }

  // One commit per page: only the files are needed, and they all come on page 1
  async compare(repository: string, base: string, head: string) {
    const result = await this.#call('GET', `/repos/${repository}/compare/${base}...${head}?per_page=1`)
    const body = result.body as { merge_base_commit: { sha: string }, files?: RawChangedFile[] }
    const files = body.files ?? []
    if (files.length >= MAX_COMPARE_FILES) throw new GitHubError(result.status, `Comparison ${base}...${head} has too many files to list completely`)
    return {
      mergeBase: body.merge_base_commit.sha,
      files: files.map(f => ({
        filename: f.filename,
        ...(f.previous_filename !== undefined && { previousFilename: f.previous_filename }),
        status: f.status,
        sha: f.sha,
        ...(f.patch !== undefined && { patch: f.patch })
      }))
    }
  }

  // GraphQL, because the REST endpoint can only merge the base in.
  // GraphQL answers 200 with an `errors` array when the mutation fails.
  async updateBranch(repository: string, pr: { number: number, nodeId: string }, expectedHeadSha: string) {
    const result = await this.#call('POST', 'graphql', {
      query: UPDATE_BRANCH_MUTATION,
      variables: { pullRequestId: pr.nodeId, expectedHeadOid: expectedHeadSha }
    })
    const body = result.body as { data?: { updatePullRequestBranch: unknown } | null, errors?: GraphQLError[] } | null
    const errors = body?.errors ?? []
    if (errors.length === 0) return Boolean(body?.data?.updatePullRequestBranch)
    // A conflict, a moved head or anything else GitHub couldn't update is the
    // developer's to fix; access and lookup failures are ours, so they throw
    if (errors.every(e => e.type === 'UNPROCESSABLE' || /conflict|could not (update|rebase)|failed to (update|rebase)/i.test(e.message))) return false
    throw new GitHubError(result.status, errors.map(e => e.message).join('; '))
  }

  async merge(repository: string, number: number, method: MergeMethod, expectedHeadSha: string) {
    const result = await this.#call('PUT', `/repos/${repository}/pulls/${number}/merge`, { merge_method: method, sha: expectedHeadSha }, [200, 405, 409])
    const body = result.body as { merged?: boolean, sha?: string, message?: string }
    return { merged: result.status === 200 && Boolean(body.merged), sha: body.sha ?? null, message: body.message ?? '' }
  }

  async closePullRequest(repository: string, number: number) {
    await this.#call('PATCH', `/repos/${repository}/pulls/${number}`, { state: 'closed' })
  }

  async deleteBranch(repository: string, branch: string) {
    await this.#call('DELETE', `/repos/${repository}/git/refs/heads/${encodeURIComponent(branch)}`, undefined, [204, 422])
  }
}
