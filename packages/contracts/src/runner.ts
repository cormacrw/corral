import type { AgentRole, RunOutcome } from '@corral/core'

// The protocol between apps/server and apps/runner over WebSocket (D7). The
// runner always dials out (D1), so the same messages work on localhost, the
// Docker network (D12) and a hosted server later. Messages are JSON.

export const RUNNER_PROTOCOL_VERSION = 1
export const RUNNER_HEARTBEAT_MS = 30_000
export const RUNNER_PATH = '/runner'

// ── Setup jobs: short requests that return data and change nothing on GitHub
// except where the server asks it to through `github` ─────────────────────────

export interface RepoSummary {
  // owner/name
  nameWithOwner: string
  description: string | null
  isPrivate: boolean
  updatedAt: string
  defaultBranch: string
  // WRITE or above is needed for agents to push and open PRs
  canPush: boolean
}

// The agent CLIs detect_clis looks for in the runner
export type CliId = 'claude' | 'codex'

export type SetupJob =
  | { kind: 'list_repos' }
  | { kind: 'check_repo', repository: string }
  | { kind: 'detect_clis' }
  // The server's GitHub API calls, made with the runner's `gh` login so the
  // token never leaves the runner (see open-recommendations.md R15)
  | { kind: 'github', method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', path: string, body?: unknown }
  // After a merge or deletion: remove the task's worktrees unless they hold
  // uncommitted work (flows.md step 10, PRD §7.4)
  | { kind: 'cleanup_worktrees', repository: string, taskId: string }

export type SetupJobResult =
  | { kind: 'list_repos', signedIn: false }
  | { kind: 'list_repos', signedIn: true, repos: RepoSummary[] }
  | { kind: 'check_repo', signedIn: boolean, found: boolean, canPush: boolean, defaultBranch: string | null, cloned: boolean, error: string | null }
  | { kind: 'detect_clis', clis: { id: CliId, version: string | null, signedIn: boolean }[] }
  | { kind: 'github', status: number, body: unknown }
  | { kind: 'cleanup_worktrees', removed: string[], kept: string[] }

// ── Runs ─────────────────────────────────────────────────────────────────────

// Everything a runner needs to start a run. No machine paths and no auth
// method (PRD §8.5, agent-runtime-and-auth.md rule 2).
export interface RunJob {
  runId: string
  runNumber: number
  leaseEpoch: number
  role: AgentRole
  // The agent's runtime id, e.g. 'claude-code': which adapter the runner
  // starts (D15). A neutral name, never an auth method.
  runtime: string
  projectId: string
  repository: string
  defaultBranch: string
  // Developer and reviewer runs
  taskId: string | null
  taskRef: string | null
  branch: string | null
  // Reviewer runs check out this commit
  headSha: string | null
  // PM turns: the Plan session, which gets its own checkout on the runner
  planSessionId: string | null
  // PM turns resume this agent session when the runner still has it
  agentSessionId: string | null
  prompt: string
  // Used instead of `prompt` when the session can't be resumed (D9: the
  // database is the source of truth; this carries a summary of it)
  fallbackPrompt: string | null
  model: string | null
  timeoutSeconds: number
}

// Structured run events, in the runtime-neutral shape web shows (rule 7)
export type RunEvent =
  | { type: 'system', text: string }
  | { type: 'message', text: string }
  // The agent's reasoning. Text can be empty when the CLI only marks that it thought.
  | { type: 'thinking', text: string }
  | { type: 'tool_call', id: string, tool: string, input: unknown }
  | { type: 'tool_result', id: string, output: string, isError: boolean }
  | { type: 'usage', inputTokens: number, outputTokens: number }

export type RunExit =
  | { kind: 'exited', code: number | null }
  | { kind: 'stopped' }
  | { kind: 'timed_out' }
  | { kind: 'rate_limited', resetsAt: string | null }
  | { kind: 'error', message: string }

// Tools an agent can call. The runner forwards each one with the run's lease
// epoch, so a stale run's calls are rejected (stale-runners-and-fencing.md).
export type AgentTool =
  | 'get_task'
  | 'add_comment'
  | 'attach_evidence'
  | 'get_evidence'
  | 'get_attachment'
  | 'report_outcome'
  | 'list_tasks'
  | 'get_run_outcomes'
  | 'ask_question'
  | 'propose_plan'
  | 'approve_plan'
  | 'flag_stale_docs'

export interface OutcomeReport {
  outcome: RunOutcome
  summary: string
  // Reviewer verdicts per acceptance criterion
  criteria?: { criterionId: string, met: boolean, note: string }[]
  // Developer: the commit the runner pushed
  headSha?: string
}

// ── Messages ─────────────────────────────────────────────────────────────────

export type RunnerMessage =
  | { type: 'hello', protocol: number, runnerId: string, name: string, activeRuns: { runId: string, leaseEpoch: number }[] }
  | { type: 'heartbeat', activeRuns: { runId: string, leaseEpoch: number }[] }
  | { type: 'job.result', jobId: string, ok: true, result: SetupJobResult }
  | { type: 'job.result', jobId: string, ok: false, error: string }
  | { type: 'run.started', runId: string, leaseEpoch: number, agentSessionId: string | null }
  | { type: 'run.events', runId: string, leaseEpoch: number, events: RunEvent[] }
  | { type: 'run.ended', runId: string, leaseEpoch: number, exit: RunExit, headSha: string | null }
  | { type: 'tool.call', callId: string, runId: string, leaseEpoch: number, tool: AgentTool, input: unknown }

export type ServerMessage =
  | { type: 'welcome', runnerId: string }
  | { type: 'job.request', jobId: string, job: SetupJob }
  | { type: 'run.assign', job: RunJob }
  | { type: 'run.stop', runId: string, reason: string }
  | { type: 'tool.result', callId: string, ok: true, result: unknown }
  | { type: 'tool.result', callId: string, ok: false, error: string }

export interface RunnerStatus {
  online: boolean
  runnerId: string | null
  name: string | null
  connectedAt: string | null
  lastHeartbeatAt: string | null
}
