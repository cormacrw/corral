import { createHash, randomUUID } from 'node:crypto'
import { readFileSync, renameSync, writeFileSync } from 'node:fs'
import type { MergeMethod } from '@corral/core'
import { FakeGitHub } from '../fake-github.ts'
import type { CheckResult, Comparison } from '../github.ts'

// The GitHub a demo instance talks to (`pnpm dev:demo`): the tests' fake,
// loaded from and saved to a JSON file in the data dir, so seeded PRs, diffs
// and checks are still there after a restart and nothing reaches real GitHub.
// Only used when CORRAL_DEMO_GITHUB names the file.
interface Snapshot {
  nextNumber: number
  branches: [string, string][]
  pulls: [number, FakeGitHub['pulls'] extends Map<number, infer P> ? P : never][]
  pullFiles: [number, FakeGitHub['pullFiles'] extends Map<number, infer F> ? F : never][]
  checkResults: [string, CheckResult[]][]
  comparisons: [string, Comparison][]
  behind: [string, number][]
  ciLogs: [string, { step: string | null, log: string }][]
}

// A commit SHA that looks like one, stable for the same seed
export function demoSha(seed: string): string {
  return createHash('sha1').update(seed).digest('hex')
}

export class DemoGitHub extends FakeGitHub {
  readonly file: string | null

  constructor(file: string | null = null) {
    super()
    this.file = file
  }

  static load(file: string): DemoGitHub {
    const github = new DemoGitHub(file)
    let snapshot: Snapshot
    try {
      snapshot = JSON.parse(readFileSync(file, 'utf8')) as Snapshot
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') return github
      throw error
    }
    github.nextNumber = snapshot.nextNumber
    github.branches = new Map(snapshot.branches)
    github.pulls = new Map(snapshot.pulls)
    github.pullFiles = new Map(snapshot.pullFiles)
    github.checkResults = new Map(snapshot.checkResults)
    github.comparisons = new Map(snapshot.comparisons)
    github.behind = new Map(snapshot.behind)
    github.ciLogs = new Map(snapshot.ciLogs)
    return github
  }

  save(file = this.file): void {
    // Only what the instance would need again; the call log would grow forever
    this.calls.length = 0
    if (!file) return
    const snapshot: Snapshot = {
      nextNumber: this.nextNumber,
      branches: [...this.branches],
      pulls: [...this.pulls],
      pullFiles: [...this.pullFiles],
      checkResults: [...this.checkResults],
      comparisons: [...this.comparisons].filter((entry): entry is [string, Comparison] => !(entry[1] instanceof Error)),
      behind: [...this.behind],
      ciLogs: [...this.ciLogs]
    }
    writeFileSync(`${file}.tmp`, JSON.stringify(snapshot))
    renameSync(`${file}.tmp`, file)
  }

  // Each merge gets its own commit, so release notes can tell merged tasks apart
  override async merge(repository: string, number: number, method: MergeMethod, expectedHeadSha: string) {
    this.mergeResult = { merged: true, sha: demoSha(`merge-${randomUUID()}`), message: 'Pull Request successfully merged' }
    return this.#saved(await super.merge(repository, number, method, expectedHeadSha))
  }

  override async createBranch(repository: string, branch: string, sha: string) {
    return this.#saved(await super.createBranch(repository, branch, sha))
  }

  override async openPullRequest(repository: string, input: { head: string, base: string, title: string, body: string }) {
    return this.#saved(await super.openPullRequest(repository, input))
  }

  override async updatePullRequest(repository: string, number: number, input: { title?: string, body?: string }) {
    return this.#saved(await super.updatePullRequest(repository, number, input))
  }

  override async updateBranch(repository: string, pull: { number: number, nodeId: string }, expectedHeadSha: string) {
    return this.#saved(await super.updateBranch(repository, pull, expectedHeadSha))
  }

  override async closePullRequest(repository: string, number: number) {
    return this.#saved(await super.closePullRequest(repository, number))
  }

  override async deleteBranch(repository: string, branch: string) {
    return this.#saved(await super.deleteBranch(repository, branch))
  }

  #saved<T>(result: T): T {
    this.save()
    return result
  }
}
