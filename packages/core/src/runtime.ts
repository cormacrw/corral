// The agent CLIs a runner can have (detect_clis)
export const CLI_IDS = ['claude', 'codex'] as const
export type CliId = typeof CLI_IDS[number]

// The runtimes an agent can run on (D15), and the CLI each one needs on the
// runner. Neutral names, never an auth method (agent-runtime-and-auth.md).
export const AGENT_RUNTIMES = { 'claude-code': 'claude', 'codex': 'codex' } as const satisfies Record<string, CliId>
export type AgentRuntime = keyof typeof AGENT_RUNTIMES
export const AGENT_RUNTIME_IDS = Object.keys(AGENT_RUNTIMES) as [AgentRuntime, ...AgentRuntime[]]

export const DEFAULT_AGENT_RUNTIME: AgentRuntime = 'claude-code'

// Runtimes whose developer and reviewer runs take messages while they run.
// Codex runs one prompt to the end, so it hears of changes from pinned comments.
export const RUNTIMES_TAKING_MESSAGES: readonly AgentRuntime[] = ['claude-code']

export function runtimeOfCli(cli: CliId): AgentRuntime {
  return AGENT_RUNTIME_IDS.find(runtime => AGENT_RUNTIMES[runtime] === cli)!
}
