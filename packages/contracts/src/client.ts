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

export function needsAttention(item: InboxItem): boolean {
  return item.type !== 'release_notes'
}
