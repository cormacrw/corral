import { homedir, hostname } from 'node:os'
import { join, resolve } from 'node:path'

// Everything environment-specific comes from env vars (D12). The defaults are
// for local development only; the Docker images set every value explicitly.
export interface RunnerConfig {
  // Holds repos/, worktrees/ and spool/ (docs/architecture.md, Layout on disk)
  dataDir: string
  // The runner always dials out to the server (D1)
  serverUrl: URL
  // Shown in the UI, e.g. "home-server"
  name: string
  // The agent CLI binary comes from configuration (agent-runtime-and-auth.md rule 4)
  claudeBin: string
  // Only detected for now (detect_clis); no agent runs on it yet
  codexBin: string
  // Author and committer of agent commits. No default (D12): unset leaves the
  // identity to whatever the agent's git finds, so startup warns about it
  gitAuthor: GitAuthor | null
  // How long a PM session's `claude` process stays alive after a turn, so the
  // next message skips startup (D9). 0 starts a new process for every turn.
  pmWarmSeconds: number
}

export interface GitAuthor {
  name: string
  email: string
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  return {
    dataDir: resolve(env.CORRAL_RUNNER_DATA_DIR || join(homedir(), '.corral', 'runner')),
    serverUrl: parseUrl(env.CORRAL_SERVER_URL || 'http://127.0.0.1:4100'),
    name: env.CORRAL_RUNNER_NAME || hostname(),
    claudeBin: env.CORRAL_CLAUDE_BIN || 'claude',
    codexBin: env.CORRAL_CODEX_BIN || 'codex',
    gitAuthor: env.CORRAL_GIT_AUTHOR_NAME && env.CORRAL_GIT_AUTHOR_EMAIL
      ? { name: env.CORRAL_GIT_AUTHOR_NAME, email: env.CORRAL_GIT_AUTHOR_EMAIL }
      : null,
    pmWarmSeconds: parseSeconds(env.CORRAL_PM_WARM_SECONDS, 300)
  }
}

// Logged at startup when no identity is configured
export function gitAuthorWarning(config: Pick<RunnerConfig, 'gitAuthor'>): string | null {
  if (config.gitAuthor) return null
  return 'CORRAL_GIT_AUTHOR_NAME and CORRAL_GIT_AUTHOR_EMAIL are not both set: agent commits will have an unpredictable author'
}

function parseSeconds(value: string | undefined, fallback: number): number {
  if (value === undefined || value === '') return fallback
  const seconds = Number(value)
  if (!Number.isInteger(seconds) || seconds < 0) {
    throw new Error(`CORRAL_PM_WARM_SECONDS must be a whole number of seconds, got "${value}"`)
  }
  return seconds
}

function parseUrl(value: string): URL {
  if (!URL.canParse(value)) {
    throw new Error(`CORRAL_SERVER_URL must be a URL, got "${value}"`)
  }
  return new URL(value)
}
