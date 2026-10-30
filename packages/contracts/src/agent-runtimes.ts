import { z } from 'zod'
import type { CliId } from './runner.ts'

// The runtimes an agent can run on (D15), and the CLI each one needs on the
// runner. Neutral names, never an auth method (agent-runtime-and-auth.md).
export const AGENT_RUNTIMES = { 'claude-code': 'claude', 'codex': 'codex' } as const satisfies Record<string, CliId>
export type AgentRuntime = keyof typeof AGENT_RUNTIMES
// Runtimes whose developer and reviewer runs take messages while they run.
// Codex runs one prompt to the end, so it hears of changes from pinned comments.
export const RUNTIMES_TAKING_MESSAGES: readonly AgentRuntime[] = ['claude-code']
export const agentRuntime = z.enum(Object.keys(AGENT_RUNTIMES) as [AgentRuntime, ...AgentRuntime[]], {
  message: `Unknown runtime; use one of ${Object.keys(AGENT_RUNTIMES).join(', ')}`
})
