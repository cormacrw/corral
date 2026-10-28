import type { MergeMethod } from '@corral/core'
import type { CheckResult, GitHubClient, PullRequest } from './github.ts'

// An in-memory GitHub for tests: branches, PRs, checks and a configurable
// merge result. Tests push a branch head with `setBranch` the way the runner
// would, then watch what the orchestrator does with it.
export class FakeGitHub implements GitHubClient {
  branches = new Map<string, string>()
  pulls = new Map<number, PullRequest & { head: string, base: string, title: string, body: string }>()
  checkResults = new Map<string, CheckResult[]>()
  // Each call records what the orchestrator asked for
  calls: { method: string, args: unknown[] }[] = []
  mergeResult: { merged: boolean, sha: string | null, message: string } | Error = { merged: true, sha: 'merge-sha', message: 'Pull Request successfully merged' }
  updateBranchResult = true
  #nextNumber = 1

  #key(repository: string, branch: string): string {
    return `${repository}#${branch}`
  }

  setBranch(repository: string, branch: string, sha: string): void {
    this.branches.set(this.#key(repository, branch), sha)
    for (const pr of this.pulls.values()) {
      if (pr.head === branch && pr.state === 'open') pr.headSha = sha
    }
  }

  setChecks(sha: string, checks: CheckResult[]): void {
    this.checkResults.set(sha, checks)
  }

  #record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
  }

  async branchHead(repository: string, branch: string): Promise<string | null> {
    this.#record('branchHead', repository, branch)
    return this.branches.get(this.#key(repository, branch)) ?? null
  }

  async findOpenPullRequest(repository: string, branch: string): Promise<PullRequest | null> {
    this.#record('findOpenPullRequest', repository, branch)
    for (const pr of this.pulls.values()) {
      if (pr.head === branch && pr.state === 'open') return { ...pr }
    }
    return null
  }

  async openPullRequest(repository: string, input: { head: string, base: string, title: string, body: string }): Promise<PullRequest> {
    this.#record('openPullRequest', repository, input)
    const head = this.branches.get(this.#key(repository, input.head))
    if (!head) throw new Error(`Branch ${input.head} doesn't exist on ${repository}`)
    const number = this.#nextNumber++
    const pr = {
      number,
      url: `https://github.com/${repository}/pull/${number}`,
      state: 'open' as const,
      merged: false,
      mergeCommitSha: null,
      headSha: head,
      mergeable: true,
      mergeableState: 'clean',
      ...input
    }
    this.pulls.set(number, pr)
    return { ...pr }
  }

  async updatePullRequest(repository: string, number: number, input: { title?: string, body?: string }): Promise<void> {
    this.#record('updatePullRequest', repository, number, input)
    const pr = this.pulls.get(number)
    if (!pr) throw new Error(`No PR #${number}`)
    if (input.title !== undefined) pr.title = input.title
    if (input.body !== undefined) pr.body = input.body
  }

  async getPullRequest(repository: string, number: number): Promise<PullRequest> {
    this.#record('getPullRequest', repository, number)
    const pr = this.pulls.get(number)
    if (!pr) throw new Error(`No PR #${number}`)
    return { ...pr }
  }

  async checks(repository: string, sha: string): Promise<CheckResult[]> {
    this.#record('checks', repository, sha)
    return this.checkResults.get(sha) ?? []
  }

  async updateBranch(repository: string, number: number, expectedHeadSha: string): Promise<boolean> {
    this.#record('updateBranch', repository, number, expectedHeadSha)
    const pr = this.pulls.get(number)
    if (!pr) throw new Error(`No PR #${number}`)
    if (!this.updateBranchResult) return false
    pr.mergeableState = 'clean'
    return true
  }

  async merge(repository: string, number: number, method: MergeMethod, expectedHeadSha: string) {
    this.#record('merge', repository, number, method, expectedHeadSha)
    if (this.mergeResult instanceof Error) throw this.mergeResult
    const pr = this.pulls.get(number)
    if (!pr) throw new Error(`No PR #${number}`)
    if (pr.headSha !== expectedHeadSha) return { merged: false, sha: null, message: 'Head branch was modified. Review and try the merge again.' }
    if (this.mergeResult.merged) {
      pr.state = 'closed'
      pr.merged = true
      pr.mergeCommitSha = this.mergeResult.sha
    }
    return { ...this.mergeResult }
  }

  async closePullRequest(repository: string, number: number): Promise<void> {
    this.#record('closePullRequest', repository, number)
    const pr = this.pulls.get(number)
    if (pr) pr.state = 'closed'
  }

  async deleteBranch(repository: string, branch: string): Promise<void> {
    this.#record('deleteBranch', repository, branch)
    this.branches.delete(this.#key(repository, branch))
  }
}
