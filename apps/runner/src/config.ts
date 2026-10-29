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
  // Author and committer of agent commits. No default (D12): unset leaves the
  // identity to whatever the agent's git finds, so startup warns about it
  gitAuthor: GitAuthor | null
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
    gitAuthor: env.CORRAL_GIT_AUTHOR_NAME && env.CORRAL_GIT_AUTHOR_EMAIL
      ? { name: env.CORRAL_GIT_AUTHOR_NAME, email: env.CORRAL_GIT_AUTHOR_EMAIL }
      : null
  }
}

// Logged at startup when no identity is configured
export function gitAuthorWarning(config: Pick<RunnerConfig, 'gitAuthor'>): string | null {
  if (config.gitAuthor) return null
  return 'CORRAL_GIT_AUTHOR_NAME and CORRAL_GIT_AUTHOR_EMAIL are not both set: agent commits will have an unpredictable author'
}

function parseUrl(value: string): URL {
  if (!URL.canParse(value)) {
    throw new Error(`CORRAL_SERVER_URL must be a URL, got "${value}"`)
  }
  return new URL(value)
}
