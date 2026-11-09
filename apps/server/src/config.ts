import { DEFAULT_SERVER_PORT } from '@corral/contracts'
import { DEFAULT_SLOW_QUERY_MS } from '@corral/db'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// Everything environment-specific comes from env vars (D12). The defaults are
// for local development only; the Docker images set every value explicitly.
interface ServerConfig {
  runnerToken: string | undefined
  runnerListen: { host: string, port: number } | undefined
  // Holds pgdata/ and blobs/ (docs/architecture.md, Layout on disk)
  dataDir: string
  host: string
  port: number
  // Set for Postgres (deployed instance, CI); unset uses PGlite in dataDir (D14)
  databaseUrl: string | undefined
  // Where people open Corral, for links in PR bodies (the web origin)
  publicUrl: string
  // A demo instance (`pnpm dev:demo`): a saved fake GitHub and a demo runner
  // instead of real ones (src/demo/). Never set in a deployment.
  demo: boolean
  // The commit this image was built from; runners on another commit are told to update
  buildSha: string
  // Requests and queries slower than these are logged
  slowRequestMs: number
  slowQueryMs: number
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  const runnerToken = env.CORRAL_RUNNER_TOKEN || undefined
  if (env.CORRAL_RUNNER_LISTEN && !runnerToken) {
    throw new Error('CORRAL_RUNNER_TOKEN is required for CORRAL_RUNNER_LISTEN')
  }
  return {
    runnerToken,
    runnerListen: env.CORRAL_RUNNER_LISTEN ? parseListen(env.CORRAL_RUNNER_LISTEN) : undefined,
    dataDir: resolve(env.CORRAL_SERVER_DATA_DIR || join(homedir(), '.corral', 'server')),
    host: env.CORRAL_SERVER_HOST || '127.0.0.1',
    port: parsePort(env.CORRAL_SERVER_PORT, DEFAULT_SERVER_PORT),
    databaseUrl: env.CORRAL_DATABASE_URL || undefined,
    publicUrl: (env.CORRAL_PUBLIC_URL || 'http://localhost:3000').replace(/\/+$/, ''),
    demo: env.CORRAL_DEMO === '1',
    buildSha: env.CORRAL_BUILD_SHA || 'development',
    slowRequestMs: parseThreshold(env.CORRAL_SLOW_REQUEST_MS, 500),
    slowQueryMs: parseThreshold(env.CORRAL_SLOW_QUERY_MS, DEFAULT_SLOW_QUERY_MS)
  }
}

// A bad value falls back to the default rather than stopping the server
function parseThreshold(value: string | undefined, fallback: number): number {
  const threshold = value === undefined ? fallback : Number(value)
  return Number.isFinite(threshold) && threshold >= 0 ? threshold : fallback
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`CORRAL_SERVER_PORT must be a port number, got "${value}"`)
  }
  return port
}

function parseListen(value: string): { host: string, port: number } {
  const match = /^(\[[^\]]+\]|[^:/]+):(\d+)$/.exec(value)
  if (!match || Number(match[2]) < 1 || Number(match[2]) > 65535) {
    throw new Error('CORRAL_RUNNER_LISTEN must be host:port (IPv6: [address]:port)')
  }
  return { host: match[1]!.replace(/^\[|\]$/g, ''), port: Number(match[2]) }
}
