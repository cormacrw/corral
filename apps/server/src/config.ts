import { homedir } from 'node:os'
import { join, resolve } from 'node:path'

// Everything environment-specific comes from env vars (D12). The defaults are
// for local development only; the Docker images set every value explicitly.
export interface ServerConfig {
  // Holds pgdata/ and blobs/ (docs/architecture.md, Layout on disk)
  dataDir: string
  host: string
  port: number
  // Set for Postgres (deployed instance, CI); unset uses PGlite in dataDir (D14)
  databaseUrl: string | undefined
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): ServerConfig {
  return {
    dataDir: resolve(env.CORRAL_SERVER_DATA_DIR || join(homedir(), '.corral', 'server')),
    host: env.CORRAL_SERVER_HOST || '127.0.0.1',
    port: parsePort(env.CORRAL_SERVER_PORT, 4100),
    databaseUrl: env.CORRAL_DATABASE_URL || undefined
  }
}

function parsePort(value: string | undefined, fallback: number): number {
  if (!value) return fallback
  const port = Number(value)
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new Error(`CORRAL_SERVER_PORT must be a port number, got "${value}"`)
  }
  return port
}
