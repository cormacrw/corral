import { tmpdir } from 'node:os'
import type { RepoSummary, SetupJob, SetupJobResult } from '@corral/contracts'
import type { RunnerConfig } from './config.ts'
import { exec } from './exec.ts'
import { inspectIntegration, prepareIntegration, pushIntegration } from './integration.ts'
import { barePath, conflictingFiles, syncRepository } from './repos.ts'
import { removeWorktree, sweepWorktrees, worktreePath } from './workspace.ts'

// Setup jobs from the server (architecture.md, "Setup jobs, not only agent
// runs"). Tokens stay in `gh`'s, `claude`'s and `codex`'s own config; these only report
// whether a login exists (D2, D12). `pmTurnRunning` says whether a Plan
// session has a turn in progress on this runner.
export async function runSetupJob(config: RunnerConfig, job: SetupJob, pmTurnRunning: (planSessionId: string) => boolean = () => false): Promise<SetupJobResult> {
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

    case 'detect_clis':
      return { kind: 'detect_clis', clis: [await detectClaude(config.claudeBin), await detectCodex(config.codexBin)] }

    case 'github':
      return githubRequest(job.method, job.path, job.body)

    case 'cleanup_worktrees': {
      // Keeps any worktree with uncommitted changes (PRD §7.4)
      const removed: string[] = []
      const kept: string[] = []
      const bare = barePath(config.dataDir, job.repository)
      for (const role of ['developer', 'reviewer'] as const) {
        const path = worktreePath(config.dataDir, job.taskId, role)
        // Review checkouts are read-only by contract, so leftover changes there are discarded
        ;(await removeWorktree(bare, path, role === 'reviewer') ? removed : kept).push(path)
      }
      return { kind: 'cleanup_worktrees', removed, kept }
    }

    case 'rebase_conflicts': {
      const error = await syncRepository(config.dataDir, job.repository)
      if (error) throw new Error(error)
      return { kind: 'rebase_conflicts', files: await conflictingFiles(barePath(config.dataDir, job.repository), job.branch, job.onto) }
    }

    case 'integration_prepare':
      return prepareIntegration(config.dataDir, config.gitAuthor, job)

    case 'integration_push':
      return pushIntegration(config.dataDir, job)

    case 'integration_inspect':
      return inspectIntegration(config.dataDir, job)

    case 'sweep_worktrees':
      return { kind: 'sweep_worktrees', ...await sweepWorktrees(config.dataDir, job, pmTurnRunning) }

    case 'session_title':
      return { kind: 'session_title', title: await sessionTitle(config, job.prompt) }

    case 'release_notes':
      return { kind: 'release_notes', notes: await releaseNotes(config, job.runtime, job.prompt) }
  }
}

export const TITLE_TIMEOUT_MS = 30_000

// One non-interactive `claude` call with the small model, no tools, no MCP
// servers and no saved session, run from a folder with no CLAUDE.md. It runs
// outside the RunManager, so it never takes a PM slot or waits for one (COR-40).
async function sessionTitle(config: RunnerConfig, prompt: string): Promise<string> {
  const result = await exec(config.claudeBin, [
    '-p', '--model', config.titleModel, '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'text'
  ], { cwd: tmpdir(), input: prompt, timeoutMs: TITLE_TIMEOUT_MS })
  const title = result.stdout.trim()
  if (result.code !== 0 || !title) throw new Error(result.stderr.trim() || `claude exited with code ${result.code}`)
  return title
}

export const RELEASE_NOTES_TIMEOUT_MS = 120_000

// One non-interactive call of the runtime's CLI with no tools and no saved
// session, from a folder with no project docs. Like a title, it runs outside
// the RunManager, so it never takes a PM slot (COR-128).
async function releaseNotes(config: RunnerConfig, runtime: string, prompt: string): Promise<string> {
  const [bin, args] = runtime === 'codex'
    ? [config.codexBin, ['exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', '-']]
    : [config.claudeBin, ['-p', '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'text']]
  const result = await exec(bin, args, { cwd: tmpdir(), input: prompt, timeoutMs: RELEASE_NOTES_TIMEOUT_MS })
  const notes = result.stdout.trim()
  if (result.code !== 0 || !notes) throw new Error(result.stderr.trim() || `${bin} exited with code ${result.code}`)
  return notes
}

// The runtime ids whose CLI is installed and signed in, for the runner's hello
export async function signedInRuntimes(config: Pick<RunnerConfig, 'claudeBin' | 'codexBin'>): Promise<string[]> {
  const [claude, codex] = await Promise.all([detectClaude(config.claudeBin), detectCodex(config.codexBin)])
  return [...(claude.signedIn ? ['claude-code'] : []), ...(codex.signedIn ? ['codex'] : [])]
}

type DetectedCli = Extract<SetupJobResult, { kind: 'detect_clis' }>['clis'][number]

async function detectClaude(bin: string): Promise<DetectedCli> {
  const version = await exec(bin, ['--version'], { timeoutMs: 15_000 })
  // Only the exit code is used: Corral never reads the login itself (D2)
  const auth = version.code === 0 ? await exec(bin, ['auth', 'status'], { timeoutMs: 15_000 }) : null
  return { id: 'claude', version: version.code === 0 ? version.stdout.trim() : null, signedIn: auth?.code === 0 }
}

// Never runs `codex login`: the human signs in inside the container (D2)
async function detectCodex(bin: string): Promise<DetectedCli> {
  const version = await exec(bin, ['--version'], { timeoutMs: 15_000 })
  if (version.code !== 0) return { id: 'codex', version: null, signedIn: false }
  const status = await exec(bin, ['login', 'status'], { timeoutMs: 15_000 })
  return { id: 'codex', version: version.stdout.trim(), signedIn: codexSignedIn(`${status.stdout}\n${status.stderr}`) }
}

// `codex login status` prints e.g. "Logged in using ChatGPT" (on stderr) or
// "Not logged in". Only the logged-in line counts; the rest says nothing secret.
export function codexSignedIn(output: string): boolean {
  return /^\s*logged in\b/im.test(output)
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
