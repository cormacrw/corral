import { availableParallelism, homedir, hostname, totalmem } from 'node:os'
import { join, resolve } from 'node:path'
import { DEFAULT_SERVER_URL, RUNNER_ROLES, type SlotSource, type RunnerRole } from '@corral/contracts'
import type { Resources } from './resources.ts'

// Everything environment-specific comes from env vars (D12). The defaults are
// for local development only; the Docker images set every value explicitly.
export interface RunnerConfig {
  runnerToken: string | undefined
  // Holds repos/, worktrees/ and spool/ (docs/architecture.md, Layout on disk; layout.ts)
  dataDir: string
  // The runner always dials out to the server (D1)
  serverUrl: URL
  // Shown in the UI, e.g. "home-server"
  name: string
  // The agent CLI binary comes from configuration (agent-runtime-and-auth.md rule 4)
  claudeBin: string
  // Claude Code's own config folder, where its login and user skills live
  claudeConfigDir: string
  // Runs agents whose runtime is 'codex'
  codexBin: string
  // Codex's own config folder, where its login and user skills live
  codexHome: string
  // Author and committer of agent commits. No default (D12): unset leaves the
  // identity to whatever the agent's git finds, so startup warns about it
  gitAuthor: GitAuthor | null
  // How long a PM session's `claude` process stays alive after a turn, so the
  // next message skips startup (D9). 0 starts a new process for every turn.
  pmWarmSeconds: number
  // The small Claude model for Plan session titles, Inbox messages and PR guides (COR-40)
  smallModel: string
  // Most agent runs this machine runs at once; the server never assigns more
  slots: number
  slotSource: SlotSource
  // The roles this runner takes runs for; 'design' is a design task's developer
  roles: RunnerRole[]
  // The commit this runner was built from, compared with the server's
  buildSha: string
  // Drain and ask the host updater as soon as the server runs a newer commit
  autoUpdate: boolean
}

export interface GitAuthor {
  name: string
  email: string
}

// Commits a runner makes on its own (WIP saves, integration candidates) when
// no identity is configured
export const FALLBACK_COMMITTER: GitAuthor = { name: 'Corral', email: 'corral@localhost' }

export function loadConfig(env: NodeJS.ProcessEnv = process.env, resources: Resources = { cpus: availableParallelism(), memoryBytes: totalmem() }): RunnerConfig {
  const home = env.HOME || homedir()
  return {
    runnerToken: env.CORRAL_RUNNER_TOKEN || undefined,
    dataDir: resolve(env.CORRAL_RUNNER_DATA_DIR || join(homedir(), '.corral', 'runner')),
    serverUrl: parseUrl(env.CORRAL_SERVER_URL || DEFAULT_SERVER_URL),
    name: env.CORRAL_RUNNER_NAME || hostname(),
    claudeBin: env.CORRAL_CLAUDE_BIN || 'claude',
    claudeConfigDir: env.CLAUDE_CONFIG_DIR || join(home, '.claude'),
    codexBin: env.CORRAL_CODEX_BIN || 'codex',
    codexHome: env.CODEX_HOME || join(home, '.codex'),
    gitAuthor: env.CORRAL_GIT_AUTHOR_NAME && env.CORRAL_GIT_AUTHOR_EMAIL
      ? { name: env.CORRAL_GIT_AUTHOR_NAME, email: env.CORRAL_GIT_AUTHOR_EMAIL }
      : null,
    pmWarmSeconds: parseSeconds(env.CORRAL_PM_WARM_SECONDS, 300),
    smallModel: env.CORRAL_TITLE_MODEL || 'haiku',
    ...slotCapacity(env, resources),
    roles: parseRoles(env.CORRAL_RUNNER_ROLES),
    buildSha: env.CORRAL_BUILD_SHA || 'development',
    autoUpdate: env.CORRAL_RUNNER_AUTO_UPDATE === 'true'
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

function parseSlots(value: string): number {
  const slots = Number(value)
  if (!Number.isInteger(slots) || slots < 1) {
    throw new Error(`CORRAL_RUNNER_SLOTS must be a whole number of at least 1, got "${value}"`)
  }
  return slots
}

// A comma-separated list, e.g. "developer,reviewer". Unset takes every role.
function parseRoles(value: string | undefined): RunnerRole[] {
  if (value === undefined || value.trim() === '') return [...RUNNER_ROLES]
  const roles = [...new Set(value.split(',').map(r => r.trim()).filter(Boolean))]
  const unknown = roles.filter(r => !(RUNNER_ROLES as readonly string[]).includes(r))
  if (unknown.length || !roles.length) {
    throw new Error(`CORRAL_RUNNER_ROLES must list roles from ${RUNNER_ROLES.join(', ')}, got "${value}"`)
  }
  return roles as RunnerRole[]
}

function parseUrl(value: string): URL {
  if (!URL.canParse(value)) {
    throw new Error(`CORRAL_SERVER_URL must be a URL, got "${value}"`)
  }
  return new URL(value)
}

export function slotCapacity(env: NodeJS.ProcessEnv, resources: Resources): { slots: number, slotSource: SlotSource } {
  if (env.CORRAL_RUNNER_SLOTS) return { slots: parseSlots(env.CORRAL_RUNNER_SLOTS), slotSource: { kind: 'explicit' } }
  const slotCpus = Number(env.CORRAL_SLOT_CPUS || '2')
  if (!Number.isFinite(slotCpus) || slotCpus <= 0) throw new Error('CORRAL_SLOT_CPUS must be a positive number')
  const memory = (env.CORRAL_SLOT_MEMORY || '2.5g').match(/^(\d+(?:\.\d+)?)\s*([bkmgt]?)b?$/i)
  const slotMemoryBytes = memory ? Number(memory[1]) * 1024 ** Math.max(0, 'bkmgt'.indexOf(memory[2]!.toLowerCase())) : NaN
  if (!Number.isFinite(slotMemoryBytes) || slotMemoryBytes <= 0) throw new Error('CORRAL_SLOT_MEMORY must be a positive size, e.g. 2.5g or 512m')
  return {
    slots: Math.max(1, Math.floor(Math.min(resources.cpus / slotCpus, resources.memoryBytes / slotMemoryBytes))),
    slotSource: { kind: 'derived', ...resources, slotCpus, slotMemoryBytes }
  }
}
