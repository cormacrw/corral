import type { RepoSummary, SetupJob, SetupJobResult } from '@corral/contracts'
import type { RunnerConfig } from './config.ts'
import { exec } from './exec.ts'
import { syncRepository } from './repos.ts'

// Setup jobs from the server (architecture.md, "Setup jobs, not only agent
// runs"). Tokens stay in `gh`'s and `claude`'s own config; these only report
// whether a login exists (D2, D12).
export async function runSetupJob(config: RunnerConfig, job: SetupJob): Promise<SetupJobResult> {
  switch (job.kind) {
    case 'list_repos': {
      if (!(await ghSignedIn())) return { kind: 'list_repos', signedIn: false }
      const result = await exec('gh', ['api', '--paginate', '--slurp',
        '/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100'], { timeoutMs: 60_000 })
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'gh api failed')
      const pages = JSON.parse(result.stdout) as GitHubRepo[][]
      return { kind: 'list_repos', signedIn: true, repos: pages.flat().map(toRepoSummary) }
    }

    case 'check_repo': {
      if (!(await ghSignedIn())) {
        return { kind: 'check_repo', signedIn: false, found: false, canPush: false, defaultBranch: null, cloned: false, error: null }
      }
      const result = await exec('gh', ['api', `/repos/${job.repository}`], { timeoutMs: 30_000 })
      if (result.code !== 0) {
        return { kind: 'check_repo', signedIn: true, found: false, canPush: false, defaultBranch: null, cloned: false, error: null }
      }
      const repo = toRepoSummary(JSON.parse(result.stdout) as GitHubRepo)
      const error = await syncRepository(config.dataDir, job.repository)
      return { kind: 'check_repo', signedIn: true, found: true, canPush: repo.canPush, defaultBranch: repo.defaultBranch, cloned: error === null, error }
    }

    case 'detect_clis': {
      const version = await exec(config.claudeBin, ['--version'], { timeoutMs: 15_000 })
      // Only the exit code is used: Corral never reads the login itself (D2)
      const auth = version.code === 0 ? await exec(config.claudeBin, ['auth', 'status'], { timeoutMs: 15_000 }) : null
      return {
        kind: 'detect_clis',
        clis: [{ id: 'claude', version: version.code === 0 ? version.stdout.trim() : null, signedIn: auth?.code === 0 }]
      }
    }

    case 'github':
      return githubRequest(job.method, job.path, job.body)
  }
}

async function ghSignedIn(): Promise<boolean> {
  return (await exec('gh', ['auth', 'status'], { timeoutMs: 15_000 })).code === 0
}

// One GitHub REST call through `gh api`, returning the status and JSON body.
// gh exits non-zero on 4xx/5xx but still prints the response.
export async function githubRequest(method: string, path: string, body?: unknown): Promise<Extract<SetupJobResult, { kind: 'github' }>> {
  const args = ['api', '--include', '-X', method, path, '-H', 'Accept: application/vnd.github+json']
  if (body !== undefined) args.push('--input', '-')
  const result = await exec('gh', args, { input: body === undefined ? '' : JSON.stringify(body), timeoutMs: 60_000 })
  const parsed = parseIncludedResponse(result.stdout)
  if (!parsed) throw new Error(result.stderr.trim() || `gh api ${method} ${path} failed`)
  return { kind: 'github', ...parsed }
}

export function parseIncludedResponse(output: string): { status: number, body: unknown } | null {
  const match = /^HTTP\/[\d.]+ (\d{3})/.exec(output)
  if (!match) return null
  const separator = output.search(/\r?\n\r?\n/)
  const text = separator === -1 ? '' : output.slice(separator).trim()
  let body: unknown = null
  if (text) {
    try {
      body = JSON.parse(text)
    } catch {
      body = text
    }
  }
  return { status: Number(match[1]), body }
}

interface GitHubRepo {
  full_name: string
  description: string | null
  private: boolean
  updated_at: string
  default_branch: string
  permissions?: { admin?: boolean, maintain?: boolean, push?: boolean }
}

export function toRepoSummary(repo: GitHubRepo): RepoSummary {
  const p = repo.permissions ?? {}
  return {
    nameWithOwner: repo.full_name,
    description: repo.description,
    isPrivate: repo.private,
    updatedAt: repo.updated_at,
    defaultBranch: repo.default_branch,
    canPush: Boolean(p.push || p.maintain || p.admin)
  }
}
