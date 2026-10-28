import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// Everything environment-specific comes from env vars (D12). The defaults are
// for local development only; the Docker images set every value explicitly.
export interface RunnerConfig {
  // Holds repos/, worktrees/ and spool/ (docs/architecture.md, Layout on disk)
  dataDir: string
  // The runner always dials out to the server (D1)
  serverUrl: URL
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): RunnerConfig {
  return {
    dataDir: resolve(env.CORRAL_RUNNER_DATA_DIR || join(homedir(), '.corral', 'runner')),
    serverUrl: parseUrl(env.CORRAL_SERVER_URL || 'http://127.0.0.1:4100')
  }
}

function parseUrl(value: string): URL {
  if (!URL.canParse(value)) {
    throw new Error(`CORRAL_SERVER_URL must be a URL, got "${value}"`)
  }
  return new URL(value)
}
