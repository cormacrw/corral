import type { MergeMethod } from '@corral/core'
import type { CheckResult, Comparison, GitHubClient, PullRequest } from './github.ts'

// An in-memory GitHub for tests: branches, PRs, checks and a configurable
// merge result. Tests push a branch head with `setBranch` the way the runner
// would, then watch what the orchestrator does with it.
export class FakeGitHub implements GitHubClient {
  branches = new Map<string, string>()
  pulls = new Map<number, PullRequest & { head: string, base: string, title: string, body: string }>()
  checkResults = new Map<string, CheckResult[]>()
  // Set with `setComparison`; comparing anything else fails
  comparisons = new Map<string, Comparison | Error>()
  // Each call records what the orchestrator asked for
  calls: { method: string, args: unknown[] }[] = []
  mergeResult: { merged: boolean, sha: string | null, message: string } | Error = { merged: true, sha: 'merge-sha', message: 'Pull Request successfully merged' }
  updateBranchResult = true
  // Runs inside updateBranch once GitHub has accepted the rebase, before it returns
  onUpdateBranch: (() => Promise<void>) | null = null
  // Commits the base has that a head doesn't, by head SHA
  behind = new Map<string, number>()
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

  setComparison(base: string, head: string, result: Comparison | Error): void {
    this.comparisons.set(`${base}...${head}`, result)
  }

  #record(method: string, ...args: unknown[]): void {
    this.calls.push({ method, args })
  }

  async createBranch(repository: string, branch: string, sha: string): Promise<void> {
    this.#record('createBranch', repository, branch, sha)
    if (!this.branches.has(this.#key(repository, branch))) this.setBranch(repository, branch, sha)
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
      nodeId: `PR_node${number}`,
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

  async behindBy(repository: string, base: string, head: string): Promise<number> {
    this.#record('behindBy', repository, base, head)
    return this.behind.get(head) ?? 0
  }

  async compare(repository: string, base: string, head: string): Promise<Comparison> {
    this.#record('compare', repository, base, head)
    const result = this.comparisons.get(`${base}...${head}`)
    if (result === undefined) throw new Error(`No comparison ${base}...${head}`)
    if (result instanceof Error) throw result
    return result
  }

  // Rebases onto the base: the head commit is rewritten, so the test pushes
  // the new head with `setBranch` the way GitHub would
  async updateBranch(repository: string, pull: { number: number, nodeId: string }, expectedHeadSha: string): Promise<boolean> {
    this.#record('updateBranch', repository, pull.number, expectedHeadSha)
    const pr = this.pulls.get(pull.number)
    if (!pr) throw new Error(`No PR #${pull.number}`)
    if (this.onUpdateBranch) await this.onUpdateBranch()
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
      if (this.mergeResult.sha) this.setBranch(repository, pr.base, this.mergeResult.sha)
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
