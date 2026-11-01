// What the web app needs at runtime, without zod: the schemas run when their
// modules load, so importing one constant from the main entry bundles them all.
// Keep this file free of schema imports.
import type { InboxItem } from './inbox.ts'
import type { CliId } from './runner.ts'

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

export function needsAttention(item: InboxItem): boolean {
  return item.type !== 'release_notes'
}
