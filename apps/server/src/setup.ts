import { AGENT_RUNTIMES, type AgentRuntime, type CliId, type CliStatus, type RepoCheck, type RepoChoice, type RepoList } from '@corral/contracts'
import { schema, type Executor } from '@corral/db'
import { ApiFailure } from './errors.ts'
import type { RunnerHub } from './runner-hub.ts'

const CACHE_MS = 3 * 60 * 1000

async function projectsByRepository(db: Executor) {
  const rows = await db.select({ repository: schema.projects.repository, slug: schema.projects.slug, name: schema.projects.name })
    .from(schema.projects)
  return new Map(rows.map(r => [r.repository.toLowerCase(), { slug: r.slug, name: r.name }]))
}

// Repositories the runner's GitHub login can see (architecture.md, setup
// jobs). The list comes from the runner and is cached for a few minutes;
// which ones are already projects is always read fresh.
export class RepoCatalog {
  #cache: { at: number, result: Extract<RepoList, { signedIn: true }> } | null = null
  #db: Executor
  #runner: RunnerHub

  constructor(db: Executor, runner: RunnerHub) {
    this.#db = db
    this.#runner = runner
  }

  async list(refresh = false): Promise<RepoList> {
    if (refresh || !this.#cache || Date.now() - this.#cache.at > CACHE_MS) {
      const result = await this.#runner.request({ kind: 'list_repos' })
      if (!result.signedIn) {
        this.#cache = null
        return { signedIn: false }
      }
      this.#cache = {
        at: Date.now(),
        result: {
          signedIn: true,
          fetchedAt: new Date().toISOString(),
          repos: result.repos.map(r => ({ ...r, selectable: r.canPush, reason: r.canPush ? null : 'read_only', usedBy: null }))
        }
      }
    }
    const used = await projectsByRepository(this.#db)
    return {
      ...this.#cache.result,
      repos: this.#cache.result.repos.map((repo): RepoChoice => {
        const usedBy = used.get(repo.nameWithOwner.toLowerCase()) ?? null
        if (usedBy) return { ...repo, usedBy, selectable: false, reason: 'used_by_project' }
        return repo
      })
    }
  }
}

// The onboarding checks for one repository (design/onboarding.md step 2)
export async function checkRepository(db: Executor, runner: RunnerHub, repository: string, timeoutMs = 5 * 60 * 1000): Promise<RepoCheck> {
  const usedBy = (await projectsByRepository(db)).get(repository.toLowerCase()) ?? null
  const result = await runner.request({ kind: 'check_repo', repository }, timeoutMs)

  const checks: RepoCheck['checks'] = [
    {
      id: 'can_push',
      ok: result.signedIn && result.found && result.canPush,
      title: 'Runner can push',
      detail: !result.signedIn
        ? 'The runner isn’t signed in to GitHub. Run `docker exec -it corral-runner gh auth login`.'
        : !result.found
            ? 'The runner’s GitHub login can’t see this repository.'
            : result.canPush
              ? 'The login has write access, so agents can push branches and open PRs.'
              : 'Read-only access: agents couldn’t push branches or open PRs.'
    },
    {
      id: 'not_used',
      ok: usedBy === null,
      title: 'Not used by another project',
      detail: usedBy ? `Used by ${usedBy.name}.` : 'No other project points at this repository.'
    },
    {
      id: 'cloned',
      ok: result.cloned,
      title: 'Cloned on the runner',
      detail: result.cloned
        ? 'The default branch is fetched into the runner’s data volume.'
        : `The runner couldn’t clone it${result.error ? `: ${result.error}` : '.'}`
    }
  ]
  return { repository, defaultBranch: result.defaultBranch, checks, ready: checks.every(c => c.ok) }
}

const CLI_NAMES: Record<CliId, string> = { claude: 'Claude Code', codex: 'Codex CLI' }

export async function detectClis(runner: RunnerHub, refresh = true): Promise<CliStatus[]> {
  const result = await runner.detectClis(refresh)
  return result.clis.map(cli => ({ id: cli.id, name: CLI_NAMES[cli.id], version: cli.version, signedIn: cli.signedIn }))
}

// Agents can only be given a runtime whose CLI is installed on the runner.
// Signing in is checked by the run itself, so a lapsed login can be fixed
// without recreating the agent.
export async function requireRuntimeCli(runner: RunnerHub, runtime: AgentRuntime): Promise<void> {
  const id = AGENT_RUNTIMES[runtime]
  const cli = (await detectClis(runner, false)).find(c => c.id === id)
  if (!cli?.version) {
    const message = `${CLI_NAMES[id]} isn’t installed on the runner, so the ${runtime} runtime can’t be used`
    throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['runtime'], message }] })
  }
}
