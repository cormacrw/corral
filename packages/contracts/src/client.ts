// What the web app needs at runtime, without zod: the schemas run when their
// modules load, so importing one constant from the main entry bundles them all.
// Keep this file free of schema imports.
import type { CliId, RunnerInfo } from './runner.ts'

// The runtimes an agent can run on (D15), and the CLI each one needs on the
// runner. Neutral names, never an auth method (agent-runtime-and-auth.md).
export const AGENT_RUNTIMES = { 'claude-code': 'claude', 'codex': 'codex' } as const satisfies Record<string, CliId>
export type AgentRuntime = keyof typeof AGENT_RUNTIMES
// Runtimes whose developer and reviewer runs take messages while they run.
// Codex runs one prompt to the end, so it hears of changes from pinned comments.
export const RUNTIMES_TAKING_MESSAGES: readonly AgentRuntime[] = ['claude-code']

export const ATTACHMENT_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type AttachmentContentType = typeof ATTACHMENT_CONTENT_TYPES[number]
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

// Sent well inside Cloudflare's ~100 s idle timeout (D12)
export const SSE_HEARTBEAT_MS = 25_000

export const PULL_REQUEST_LINE_LIMIT = 1000

// A file's patch split into its `@@` hunks, each a list of lines starting with
// its `@@` header. A guide's `{ path, hunk }` refs index into this, on the
// server and in the web app alike (COR-525).
export function splitPatchHunks(patch: string): string[][] {
  if (!patch) return []
  const hunks: string[][] = []
  for (const line of patch.split('\n')) {
    if (line.startsWith('@@') || hunks.length === 0) hunks.push([])
    hunks.at(-1)!.push(line)
  }
  return hunks
}

// How long a runner kept from work may show no update attempt before a human
// hears about it. The host updater's timer ticks every minute.
export const RUNNER_UPDATE_GRACE_MS = 5 * 60_000

// What a human has to look at for this runner, or null. A failed attempt says
// why. A runner kept from work that shows no attempt has nothing updating it:
// tools that differ, or a protocol the server refused, whose runner is offline.
export function runnerUpdateProblem(runner: RunnerInfo, now = Date.now()): string | null {
  if (!runner.behind && !runner.toolContractReason && !runner.needsUpdate) return null
  if (runner.updateState === 'failed') return runner.updateError || 'The host updater failed without saying why.'
  if (runner.updateState || now - Date.parse(runner.connectedAt) <= RUNNER_UPDATE_GRACE_MS) return null
  const fix = 'Check the host updater timer (corral-runner-update), or update it by hand.'
  if (runner.needsUpdate) return `The server refuses its protocol version (${runner.protocol}), and no update attempt has started. ${fix}`
  if (runner.toolContractReason && runner.online) return `No update attempt since it connected. ${runner.toolContractReason} ${fix}`
  return null
}

// A runner's id in the Inbox, kept stable so the row survives reconnects
export const runnerItemId = (runnerId: string) => `runner-${runnerId}`

// Explicit patterns keep identifiers and query strings out of diagnostics.
export const PAGE_PATTERNS = [
  '/', '/home', '/projects', '/setup', '/plan', '/plan/[sessionId]',
  '/projects/[slug]', '/projects/[slug]/board', '/projects/[slug]/backlog',
  '/projects/[slug]/settings', '/projects/[slug]/pull-requests',
  '/tasks/[ref]', '/epics/[id]', '/designs/[versionId]',
  '/inbox', '/inbox/[itemId]',
  '/settings', '/settings/[section]', '/settings/profile', '/settings/agents',
  '/settings/runner', '/settings/performance', '/settings/appearance',
  '/agents/[name]/[[runId]]'
] as const

export const PERF_WINDOWS = ['1h', '24h', '7d'] as const
export type PerfWindow = (typeof PERF_WINDOWS)[number]

// Dollars per million tokens. Fresh input has no agreed weight, so the weighted
// cost leaves it out and it's always shown beside the cost.
export const CACHE_COST_WEIGHTS = { cacheRead: 0.2, cacheWrite: 8, output: 20 } as const

interface RunUsage {
  agentRuntime: string
  cacheWriteTokens?: number | null
  cacheReadTokens: number | null
  outputTokens: number | null
}

// Codex has no cache writes to report. A Claude run without them is from
// before they were stored, and has them inside its input tokens.
export function cacheWritesUnknown(run: Pick<RunUsage, 'agentRuntime' | 'cacheWriteTokens'>): boolean {
  return (run.cacheWriteTokens === null || run.cacheWriteTokens === undefined) && run.agentRuntime !== 'codex'
}

// Null when cache writes are unknown: without them, runs don't compare
export function weightedRunCost(run: RunUsage): number | null {
  if (cacheWritesUnknown(run)) return null
  return ((run.cacheWriteTokens ?? 0) * CACHE_COST_WEIGHTS.cacheWrite
    + (run.cacheReadTokens ?? 0) * CACHE_COST_WEIGHTS.cacheRead
    + (run.outputTokens ?? 0) * CACHE_COST_WEIGHTS.output) / 1_000_000
}
