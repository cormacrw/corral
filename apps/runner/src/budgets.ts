import { TOOL_CALL_TIMEOUT_MS } from '@corral/contracts'

// Time budgets for an agent's tool calls, which depend on each other.

// One push of the run's branch
export const PUSH_TIMEOUT_MS = 5 * 60_000

// report_outcome pushes before it waits for the server, so a Codex tool call
// needs room for both; Codex's own default of 60 s would give up first
export const MCP_TOOL_TIMEOUT_SECONDS = (TOOL_CALL_TIMEOUT_MS + PUSH_TIMEOUT_MS) / 1000 + 30

// Saving a stopped run's work: the WIP commit and push, and reading the head
// after. A push only goes out with a lease confirmed for at least this long.
export const SAVE_WORK_TIMEOUT_MS = 5_000
