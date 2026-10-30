import type { AgentRole, RunOutcome, TaskType } from '@corral/core'

// The protocol between apps/server and apps/runner over WebSocket (D7). The
// runner always dials out (D1), so the same messages work on localhost, the
// Docker network (D12) and a hosted server later. Messages are JSON.

// 3: build identity and drain state (COR-187)
// 2: hello carries the runner's slots, runtimes and roles (COR-184)
export const RUNNER_PROTOCOL_VERSION = 3
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
  // A Plan session's short title: the runner's `claude` CLI answers the
  // prompt with its smallest model and no tools (COR-40). Never a PM slot.
  | { kind: 'session_title', prompt: string }
  // A deployment's release notes: the `runtime` CLI answers the prompt once,
  // with no tools (COR-128). Never a PM slot.
  | { kind: 'release_notes', runtime: string, prompt: string }

export type SetupJobResult =
  | { kind: 'list_repos', signedIn: false }
  | { kind: 'list_repos', signedIn: true, repos: RepoSummary[] }
  | { kind: 'check_repo', signedIn: boolean, found: boolean, canPush: boolean, defaultBranch: string | null, cloned: boolean, error: string | null }
  | { kind: 'detect_clis', clis: { id: CliId, version: string | null, signedIn: boolean }[] }
  | { kind: 'github', status: number, body: unknown }
  | { kind: 'cleanup_worktrees', removed: string[], kept: string[] }
  // The model's raw answer; the server cleans it up
  | { kind: 'session_title', title: string }
  | { kind: 'release_notes', notes: string }

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
  // Actual task PR base; absent for older servers and PM runs.
  baseBranch?: string
  // Developer and reviewer runs
  taskId: string | null
  // Integration review: the epic instead of an individual task.
  epicId?: string
  taskRef: string | null
  // The task's type: a design task's developer gets submit_design (D20).
  // Absent on PM turns and from older servers.
  taskType?: TaskType | null | undefined
  // A build task pinned to a design version (D20): the runner saves the
  // version as read-only files in the scratch folder before the agent
  // starts. Absent from older servers.
  designPinned?: boolean | undefined
  branch: string | null
  // Reviewer runs check out this commit
  headSha: string | null
  // Developer runs after a stopped one: the WIP commit it pushed, which the
  // worktree must contain. Absent from older servers.
  continueFrom?: string | null | undefined
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
  // inputTokens is fresh input (including cache writes); cache reads are counted apart
  | { type: 'usage', inputTokens: number, cacheReadTokens: number, outputTokens: number }

export type RunExit =
  | { kind: 'exited', code: number | null }
  // Asked to stop by the server, with its reason. The optional fields here and
  // on run.ended are missing from a runner that hasn't been updated yet.
  | { kind: 'stopped', reason?: string }
  | { kind: 'timed_out', limitSeconds?: number }
  // The runner process itself was told to stop (container stop or redeploy)
  | { kind: 'runner_shutdown' }
  // Killed by a signal Corral didn't send
  | { kind: 'signalled', signal: string }
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
  | 'get_design'
  | 'submit_design'
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
  // Developer: a one-line work note, posted as a comment by the agent
  note?: string
  // Reviewer verdicts per acceptance criterion
  criteria?: { criterionId: string, met: boolean, note: string }[]
  // Developer: the commit the runner pushed
  headSha?: string
}

// ── Messages ─────────────────────────────────────────────────────────────────

export type RunnerMessage =
  | { type: 'hello', protocol: number, commit: string, draining?: boolean, updateRequested?: boolean, autoUpdate?: boolean, runnerId: string, name: string, activeRuns: { runId: string, leaseEpoch: number }[] } & RunnerCapacity
  | { type: 'runner.draining', updateRequested: boolean }
  | { type: 'heartbeat', sentAt?: number, activeRuns: { runId: string, leaseEpoch: number }[] }
  | { type: 'job.result', jobId: string, ok: true, result: SetupJobResult }
  | { type: 'job.result', jobId: string, ok: false, error: string }
  | { type: 'run.started', sentAt?: number, runId: string, leaseEpoch: number, agentSessionId: string | null }
  | { type: 'run.events', runId: string, leaseEpoch: number, events: RunEvent[] }
  // lastActivityAt: when the agent last wrote to its transcript
  // wipSha: the commit that saved a stopped developer run's work, once pushed
  | { type: 'run.ended', runId: string, leaseEpoch: number, exit: RunExit, headSha: string | null, lastActivityAt?: string | null, wipSha?: string | null }
  | { type: 'tool.call', callId: string, runId: string, leaseEpoch: number, tool: AgentTool, input: unknown }
  // A run.message the runner could not deliver: a Codex or PM run, or a run
  // that has ended. Messages with a stale lease epoch get no answer (fencing).
  | { type: 'run.message.rejected', runId: string, leaseEpoch: number, text: string, error: string }

export type ServerMessage =
  | { type: 'welcome', runnerId: string, commit: string, draining: boolean, updateRequested: boolean }
  // A short-lived acknowledgement of a live lease; expired acknowledgements never authorise a WIP push.
  | { type: 'run.lease', runId: string, leaseEpoch: number, validUntil: string }
  | { type: 'runner.drain', updateRequested: boolean }
  | { type: 'job.request', jobId: string, job: SetupJob }
  | { type: 'run.assign', job: RunJob }
  // keepWork: a developer run saves and pushes its uncommitted work. Only for
  // a stop the task will be retried after: without it nothing is pushed, so a
  // revoked run never pushes; local stops also require a recent lease acknowledgement.
  | { type: 'run.stop', runId: string, reason: string, keepWork?: boolean }
  // A human's message for a live Claude Code developer or reviewer run. The
  // runner writes it to the agent's stdin and records it as a message event.
  | { type: 'run.message', runId: string, leaseEpoch: number, text: string }
  | { type: 'tool.result', callId: string, ok: true, result: unknown }
  | { type: 'tool.result', callId: string, ok: false, error: string }

// What a runner takes on, sent in its hello. The server only assigns a run
// to a runner that takes its role, has its runtime and has a free slot.
export type SlotSource = { kind: 'explicit' } | {
  kind: 'derived'
  cpus: number
  memoryBytes: number
  slotCpus: number
  slotMemoryBytes: number
}

export interface RunnerCapacity {
  // Optional for runners deployed before resource-based sizing.
  slotSource?: SlotSource | undefined
  // Most agent runs the machine runs at once (CORRAL_RUNNER_SLOTS)
  slots: number
  // Runtime ids with a signed-in CLI, e.g. 'claude-code', 'codex'
  runtimes: string[]
  // Agent roles it takes (CORRAL_RUNNER_ROLES); design runs are developer
  // runs on design tasks, taken only with 'design'
  roles: RunnerRole[]
}

export type RunnerRole = AgentRole | 'design'
export const RUNNER_ROLES: readonly RunnerRole[] = ['pm', 'developer', 'reviewer', 'design']

export interface RunnerInfo extends RunnerCapacity {
  commit: string
  serverCommit: string
  behind: boolean
  draining: boolean
  updateRequested: boolean
  id: string
  name: string
  online: boolean
  // Agent runs on this runner right now, out of `slots`
  slotsInUse: number
  // The protocol its last hello spoke. A runner on another version than the
  // server's was turned away (closed with 4000) and needs updating.
  protocol: number
  needsUpdate: boolean
  connectedAt: string
  lastHeartbeatAt: string
}

export interface RunnerStatus {
  runners: RunnerInfo[]
  // The protocol version this server speaks (RUNNER_PROTOCOL_VERSION)
  protocol: number
  // Aggregate compatibility fields for the shell: online means any runner.
  online: boolean
  runnerId: string | null
  name: string | null
  connectedAt: string | null
  lastHeartbeatAt: string | null
}
