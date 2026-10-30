import type { SetupJob, SetupJobResult } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { GitHubError, RunnerGitHub } from './github.ts'
import type { RunnerHub } from './runner-hub.ts'

// RunnerGitHub against a stub runner that answers each `gh api` job
function stub(answer: (job: Extract<SetupJob, { kind: 'github' }>) => { status: number, body: unknown }) {
  const jobs: Extract<SetupJob, { kind: 'github' }>[] = []
  const runner = {
    async request(job: Extract<SetupJob, { kind: 'github' }>): Promise<SetupJobResult> {
      jobs.push(job)
      return { kind: 'github', ...answer(job) }
    }
  } as unknown as RunnerHub
  return { github: new RunnerGitHub(runner), jobs }
}

const pr = { number: 7, nodeId: 'PR_kwDOAbc' }

describe('RunnerGitHub.updateBranch', () => {
  it('rebases through the GraphQL updatePullRequestBranch mutation', async () => {
    const { github, jobs } = stub(() => ({ status: 200, body: { data: { updatePullRequestBranch: { pullRequest: { headRefOid: 'new' } } } } }))
    expect(await github.updateBranch('owner/repo', pr, 'abc123')).toBe(true)
    expect(jobs).toHaveLength(1)
    const [job] = jobs
    expect(job).toMatchObject({ kind: 'github', method: 'POST', path: 'graphql' })
    const body = job!.body as { query: string, variables: Record<string, string> }
    expect(body.query).toContain('updatePullRequestBranch')
    expect(body.query).toContain('updateMethod: REBASE')
    expect(body.query).toContain('expectedHeadOid: $expectedHeadOid')
    expect(body.variables).toEqual({ pullRequestId: 'PR_kwDOAbc', expectedHeadOid: 'abc123' })
  })

  it('returns false when GitHub answers 200 with a conflict in the errors array', async () => {
    const { github } = stub(() => ({
      status: 200,
      body: { data: { updatePullRequestBranch: null }, errors: [{ type: 'UNPROCESSABLE', path: ['updatePullRequestBranch'], message: 'Failed to update pull request branch: merge conflict' }] }
    }))
    expect(await github.updateBranch('owner/repo', pr, 'abc123')).toBe(false)
  })

  it('returns false for a failed rebase reported without an error type', async () => {
    const { github } = stub(() => ({ status: 200, body: { data: null, errors: [{ message: 'Could not rebase: conflict in README.md' }] } }))
    expect(await github.updateBranch('owner/repo', pr, 'abc123')).toBe(false)
  })

  it('throws on other GraphQL errors and on HTTP failures', async () => {
    const forbidden = stub(() => ({ status: 200, body: { data: null, errors: [{ type: 'FORBIDDEN', message: 'Resource not accessible by integration' }] } }))
    await expect(forbidden.github.updateBranch('owner/repo', pr, 'abc123')).rejects.toThrow(GitHubError)
    const down = stub(() => ({ status: 502, body: { message: 'Bad gateway' } }))
    await expect(down.github.updateBranch('owner/repo', pr, 'abc123')).rejects.toThrow('Bad gateway')
  })
})

describe('RunnerGitHub.compare', () => {
  it('reads the merge base and each file\'s change', async () => {
    const { github, jobs } = stub(() => ({ status: 200, body: {
      merge_base_commit: { sha: 'base' },
      files: [
        { filename: 'a.ts', status: 'modified', sha: 'blob-a', patch: '+a' },
        { filename: 'b.png', previous_filename: 'old.png', status: 'renamed', sha: 'blob-b' }
      ]
    } }))
    expect(await github.compare('owner/repo', 'one', 'two')).toEqual({
      mergeBase: 'base',
      files: [
        { filename: 'a.ts', status: 'modified', sha: 'blob-a', patch: '+a' },
        { filename: 'b.png', previousFilename: 'old.png', status: 'renamed', sha: 'blob-b' }
      ]
    })
    expect(jobs[0]).toMatchObject({ method: 'GET', path: '/repos/owner/repo/compare/one...two?per_page=1' })
  })

  it('refuses a file list GitHub may have cut short', async () => {
    const files = Array.from({ length: 300 }, (_, i) => ({ filename: `f${i}.ts`, status: 'modified', sha: 'x' }))
    const { github } = stub(() => ({ status: 200, body: { merge_base_commit: { sha: 'base' }, files } }))
    await expect(github.compare('owner/repo', 'one', 'two')).rejects.toThrow('too many files')
  })

  it('throws on HTTP failures', async () => {
    const { github } = stub(() => ({ status: 404, body: { message: 'No common ancestor' } }))
    await expect(github.compare('owner/repo', 'one', 'two')).rejects.toBeInstanceOf(GitHubError)
  })
})

describe('RunnerGitHub.createBranch', () => {
  it('creates a ref at the configured target tip', async () => {
    const { github, jobs } = stub(() => ({ status: 201, body: {} }))
    await github.createBranch('owner/repo', 'corral/epic-feature', 'develop-tip')
    expect(jobs).toEqual([{ kind: 'github', method: 'POST', path: '/repos/owner/repo/git/refs', body: { ref: 'refs/heads/corral/epic-feature', sha: 'develop-tip' } }])
  })

  it('accepts a concurrent creation without resetting the branch', async () => {
    const { github, jobs } = stub(job => job.method === 'POST'
      ? { status: 422, body: { message: 'Reference already exists' } }
      : { status: 200, body: { object: { sha: 'existing-tip' } } })
    await github.createBranch('owner/repo', 'corral/epic-feature', 'develop-tip')
    expect(jobs.map(j => j.method)).toEqual(['POST', 'GET'])
  })
})
