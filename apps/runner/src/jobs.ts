import { SETUP_JOB_TIMEOUTS, SETUP_STEP_TIMEOUTS, type RepoSummary, type SetupJob, type SetupJobResult } from '@corral/contracts'
import { DEFAULT_AGENT_RUNTIME } from '@corral/core'
import { CiLogScanner } from './ci-log.ts'
import type { RunnerConfig } from './config.ts'
import { gh } from './exec.ts'
import { inspectEpicRebase, prepareEpicRebase, pushEpicRebase } from './epic-rebase.ts'
import { inspectIntegration, prepareIntegration, pushIntegration } from './integration.ts'
import { discardsChanges, workspaceKey, worktreePath } from './layout.ts'
import { openRepo } from './repos.ts'
import type { Runtimes } from './runtimes.ts'
import { sweepWorktrees, type LocalRuns } from './sweep.ts'
import { removeWorktree } from './workspace.ts'

// What a setup job runs against: this runner's config, its agent runtimes and its own runs
export interface SetupContext {
  config: RunnerConfig
  runtimes: Runtimes
  runs: LocalRuns
}

// Setup jobs from the server (architecture.md, "Setup jobs, not only agent
// runs"). Tokens stay in `gh`'s and each agent CLI's own config; these only
// report whether a login exists (D2, D12).
export async function runSetupJob({ config, runtimes, runs }: SetupContext, job: SetupJob): Promise<SetupJobResult> {
  switch (job.kind) {
    case 'list_repos': {
      if (!(await ghSignedIn())) return { kind: 'list_repos', signedIn: false }
      const result = await gh(['api', '--paginate', '--slurp',
        '/user/repos?affiliation=owner,collaborator,organization_member&sort=updated&per_page=100'], { timeoutMs: SETUP_STEP_TIMEOUTS.ghApi })
      if (result.code !== 0) throw new Error(result.stderr.trim() || 'gh api failed')
      const pages = JSON.parse(result.stdout) as GitHubRepo[][]
      return { kind: 'list_repos', signedIn: true, repos: pages.flat().map(toRepoSummary) }
    }

    case 'check_repo': {
      if (!(await ghSignedIn())) {
        return { kind: 'check_repo', signedIn: false, found: false, canPush: false, defaultBranch: null, cloned: false, error: null }
      }
      const result = await gh(['api', `/repos/${job.repository}`], { timeoutMs: SETUP_STEP_TIMEOUTS.ghRepo })
      if (result.code !== 0) {
        return { kind: 'check_repo', signedIn: true, found: false, canPush: false, defaultBranch: null, cloned: false, error: null }
      }
      const repo = toRepoSummary(JSON.parse(result.stdout) as GitHubRepo)
      const error = await openRepo(config.dataDir, job.repository).sync()
      return { kind: 'check_repo', signedIn: true, found: true, canPush: repo.canPush, defaultBranch: repo.defaultBranch, cloned: error === null, error }
    }

    case 'detect_clis':
      return { kind: 'detect_clis', clis: await runtimes.detect() }

    case 'github':
      return job.tailChars ? githubLog(job.path, job.tailChars) : githubRequest(job.method, job.path, job.body)

    case 'cleanup_worktrees': {
      const removed: string[] = []
      const kept: string[] = []
      const repo = openRepo(config.dataDir, job.repository)
      const owner = job.taskId === undefined ? { kind: 'epic' as const, epicId: job.epicId } : { kind: 'task' as const, taskId: job.taskId }
      for (const role of ['developer', 'reviewer'] as const) {
        const path = worktreePath(config.dataDir, workspaceKey(job), role)
        ;(await removeWorktree(repo, path, discardsChanges({ ...owner, review: role === 'reviewer' })) ? removed : kept).push(path)
      }
      return { kind: 'cleanup_worktrees', removed, kept }
    }

    case 'integration_prepare':
      return prepareIntegration(config.dataDir, config.gitAuthor, job)

    case 'integration_push':
      return pushIntegration(config.dataDir, job)

    case 'integration_inspect':
      return inspectIntegration(config.dataDir, job)

    case 'epic_rebase_prepare':
      return prepareEpicRebase(config.dataDir, config.gitAuthor, job)

    case 'epic_rebase_push':
      return pushEpicRebase(config.dataDir, job)

    case 'epic_rebase_inspect':
      return inspectEpicRebase(config.dataDir, job)

    case 'sweep_worktrees':
      return { kind: 'sweep_worktrees', ...await sweepWorktrees(config.dataDir, job, runs) }

    // These carry no runtime, so they ask the default one with its small model
    case 'inbox_message':
      return { kind: 'inbox_message', message: await ask(runtimes, DEFAULT_AGENT_RUNTIME, job.prompt, { model: config.smallModel, timeoutMs: SETUP_JOB_TIMEOUTS.inbox_message.runnerMs }) }

    case 'session_title':
      return { kind: 'session_title', title: await ask(runtimes, DEFAULT_AGENT_RUNTIME, job.prompt, { model: config.smallModel, timeoutMs: SETUP_JOB_TIMEOUTS.session_title.runnerMs }) }

    case 'pr_guide':
      return { kind: 'pr_guide', text: await ask(runtimes, DEFAULT_AGENT_RUNTIME, job.prompt, { model: config.smallModel, timeoutMs: SETUP_JOB_TIMEOUTS.pr_guide.runnerMs }) }

    // COR-128
    case 'release_notes':
      return { kind: 'release_notes', notes: await ask(runtimes, job.runtime, job.prompt, { model: null, timeoutMs: SETUP_JOB_TIMEOUTS.release_notes.runnerMs }) }
  }
}

function ask(runtimes: Runtimes, runtime: string, prompt: string, options: { model: string | null, timeoutMs: number }): Promise<string> {
  const adapter = runtimes.get(runtime)
  if (!adapter) throw new Error(`This runner has no agent runtime "${runtime}"`)
  return adapter.ask(prompt, options)
}

async function ghSignedIn(): Promise<boolean> {
  return (await gh(['auth', 'status'], { timeoutMs: SETUP_STEP_TIMEOUTS.ghAuth })).code === 0
}

type GitHubResult = Extract<SetupJobResult, { kind: 'github' }>

// One GitHub REST call through `gh api`, returning the status and JSON body.
// gh exits non-zero on 4xx/5xx but still prints the response.
export async function githubRequest(method: string, path: string, body?: unknown): Promise<GitHubResult> {
  const args = ['api', '--include', '-X', method, path, '-H', 'Accept: application/vnd.github+json']
  if (body !== undefined) args.push('--input', '-')
  const result = await gh(args, { input: body === undefined ? '' : JSON.stringify(body), timeoutMs: SETUP_STEP_TIMEOUTS.ghApi })
  const parsed = parseIncludedResponse(result.stdout)
  if (!parsed) throw new Error(result.stderr.trim() || `gh api ${method} ${path} failed`)
  return { kind: 'github', ...parsed }
}

// A CI log is full of terminal colours, which newer `gh` won't print unasked,
// and can run to tens of megabytes. It's read as it arrives, keeping the end
// and any failure lines from the whole of it. The colours go no further than
// the server, which strips them before a prompt sees the log.
export async function githubLog(path: string, tailChars: number): Promise<GitHubResult> {
  const args = ['api', '--include', '-X', 'GET', path, '-H', 'Accept: application/vnd.github+json']
  const read = async (flags: string[]) => {
    let head = ''
    let scanner: CiLogScanner | null = null
    const result = await gh([...args, ...flags], {
      timeoutMs: SETUP_STEP_TIMEOUTS.ghApi,
      onStdout: (chunk) => {
        if (scanner) return scanner.write(chunk)
        head += chunk
        const separator = /\r?\n\r?\n/.exec(head)
        if (!separator) return
        scanner = new CiLogScanner(tailChars)
        scanner.write(head.slice(separator.index + separator[0].length))
        head = head.slice(0, separator.index)
      }
    })
    return { result, head, log: (scanner as CiLogScanner | null)?.finish() ?? null }
  }
  // Older `gh` prints the colours anyway, and refuses a flag it doesn't know
  let attempt = await read(['--allow-escape-sequences'])
  if (/unknown flag/.test(attempt.result.stderr)) attempt = await read([])
  const { result, head, log } = attempt
  const parsed = result.code === null ? null : parseIncludedResponse(`${head}\n\n${log?.tail ?? ''}`)
  if (!parsed) throw new Error(result.stderr.trim() || `gh api GET ${path} failed`)
  return { kind: 'github', ...parsed, failureLines: log?.failureLines ?? [] }
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
