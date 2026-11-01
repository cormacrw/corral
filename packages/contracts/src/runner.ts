import { REBASE_REVIEWS, RUN_OUTCOMES, REVIEW_VERDICTS, TASK_TYPES, type AgentRole, type ReviewVerdict } from '@corral/core'
import { z } from 'zod'

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

export type SetupJob = z.infer<typeof setupJobSchema>

export type SetupJobResult = z.infer<typeof setupJobResultSchema>

// ── Runs ─────────────────────────────────────────────────────────────────────

// Everything a runner needs to start a run. No machine paths and no auth
// method (PRD §8.5, agent-runtime-and-auth.md rule 2).
const runJobCommon = {
  runId: z.string(), runNumber: z.number(), leaseEpoch: z.number(),
  runtime: z.string(), projectId: z.string(), repository: z.string(),
  defaultBranch: z.string(), agentSessionId: z.string().nullable(),
  prompt: z.string(), fallbackPrompt: z.string().nullable(), model: z.string().nullable(),
  timeoutSeconds: z.number()
}
const taskJobContext = {
  integrationProtocol: z.number().int().nonnegative().optional(),
  baseBranch: z.string().optional(), taskId: z.string().min(1), taskRef: z.string().min(1),
  // Older servers omit taskType and designPinned; preserve absence.
  epicId: z.string().optional(), taskType: z.enum(TASK_TYPES).nullish(),
  designPinned: z.boolean().optional(), branch: z.string().nullable(),
  headSha: z.string().nullable(), planSessionId: z.null(),
  // Developer runs after a stopped one: the WIP commit it pushed, which the
  // worktree must contain. Absent from older servers.
  continueFrom: z.string().nullish()
}
export const pmRunJobSchema = z.object({
  ...runJobCommon, role: z.literal('pm'), planSessionId: z.string().min(1),
  taskId: z.null(), taskRef: z.null(), branch: z.null(), headSha: z.null(),
  baseBranch: z.never().optional(), epicId: z.never().optional(),
  taskType: z.null().optional(), designPinned: z.never().optional(), continueFrom: z.never().optional()
})
export const developerRunJobSchema = z.object({ ...runJobCommon, ...taskJobContext, role: z.literal('developer') })
export const reviewerRunJobSchema = z.object({ ...runJobCommon, ...taskJobContext, role: z.literal('reviewer') })
// D20 designers have their own role and only ever author design tasks.
export const designerRunJobSchema = z.object({ ...runJobCommon, ...taskJobContext, role: z.literal('designer'), taskType: z.literal('design') })
// D23 integration reviews target an epic rather than pretending it is a task.
export const epicReviewerRunJobSchema = z.object({
  ...runJobCommon, role: z.literal('reviewer'), taskId: z.null(), taskRef: z.null(),
  epicId: z.string().min(1), branch: z.string().min(1), headSha: z.string().min(1),
  baseBranch: z.string().optional(), planSessionId: z.null(),
  taskType: z.never().optional(), designPinned: z.never().optional(), continueFrom: z.never().optional()
})
export const runJobSchema = z.union([
  z.discriminatedUnion('role', [pmRunJobSchema, developerRunJobSchema, designerRunJobSchema, reviewerRunJobSchema]),
  epicReviewerRunJobSchema
])
export type RunJob = z.infer<typeof runJobSchema>
export type PmRunJob = z.infer<typeof pmRunJobSchema>
export type DesignerRunJob = z.infer<typeof designerRunJobSchema>

// Structured run events, in the runtime-neutral shape web shows (rule 7)
export type RunEvent = z.infer<typeof runEventSchema>

// Where a run's time went. An `agent_*` phase is one agent process or turn,
// less any phase nested in it: a push or design pack inside a tool call
// pauses the agent's clock. `other` is everything unnamed.
export const runPhaseSchema = z.enum([
  'worktree_prepare', 'session_setup', 'design_save', 'agent_cold_start',
  'agent_resume', 'agent_warm_turn', 'design_pack', 'push', 'finish', 'other'
])
export type RunPhase = z.infer<typeof runPhaseSchema>

// Measured by the runner from assignment to run.ended, so totalMs starts
// before the run's startedAt and can end after its endedAt.
export const runTimingsSchema = z.object({
  totalMs: z.number(),
  // In the order the run first entered them; they add up to totalMs
  phases: z.array(z.object({ phase: runPhaseSchema, durationMs: z.number() })),
  tools: z.array(z.object({ tool: z.string(), count: z.number(), totalMs: z.number(), maxMs: z.number() }))
})
export type RunTimings = z.infer<typeof runTimingsSchema>

export type RunExit = z.infer<typeof runExitSchema>

// Tools an agent can call. The runner forwards each one with the run's lease
// epoch, so a stale run's calls are rejected (stale-runners-and-fencing.md).
export type AgentTool = z.infer<typeof agentToolSchema>

// What an agent can report. `rate_limited` comes from the run's exit, never from
// the agent.
const REPORTED_OUTCOMES = z.enum(RUN_OUTCOMES).exclude(['rate_limited'])
const NON_REVIEW_OUTCOMES = REPORTED_OUTCOMES.exclude([...REVIEW_VERDICTS])
const REVIEW_OUTCOMES = z.enum(REVIEW_VERDICTS)
const unknownOutcome = `must be one of ${REPORTED_OUTCOMES.options.join(', ')}`
const criterionVerdict = z.object({ criterionId: z.string(), met: z.boolean(), note: z.string().default('') })
const missingCriteria = 'Give a verdict for every acceptance criterion'

// What an epic rebase's developer or reviewer asks the human when keeping both
// sides would mean choosing product behaviour (COR-291)
export const epicDecisionInput = z.object({
  question: z.string().trim().min(1).describe('One focused question for the human'),
  bindingDecision: z.string().trim().min(1).optional().describe('The binding decision that changed, if that is the cause, e.g. "D31 in docs/decisions.md"'),
  alternatives: z.array(z.object({
    label: z.string().trim().min(1).describe('A short name for this choice'),
    effect: z.string().trim().min(1).describe('What the product does if this is chosen'),
    changesBehaviour: z.boolean().describe('True when this changes the behaviour the human approved, so the epic goes back through review')
  })).min(2, 'Give at least two alternatives').max(5),
  affectedChanges: z.array(z.string().trim().min(1)).min(1, 'Name the changes affected').describe('The commits, files or tasks on each side this decision affects')
})

// The report_outcome tool's arguments. MCP clients need a plain object as a
// tool's input, so this stays flat; the schemas below decide which fields each
// outcome needs.
export const reportOutcomeInput = z.object({
  outcome: REPORTED_OUTCOMES.describe('One of the outcomes listed for your role'),
  summary: z.string().trim().min(1, 'Add a summary').describe('Plain-English summary of what you did, or your question when stuck'),
  review: z.enum(REBASE_REVIEWS).optional().describe('Required for pr_rebased: trivial only for combining both sides with no new logic, renames or behaviour changes; otherwise needs_review'),
  conflictedFiles: z.array(z.string().trim().min(1)).min(1, 'conflictedFiles must contain at least one file').optional().describe('Required for pr_rebased: every file in which you resolved a conflict'),
  note: z.string().trim().optional().describe('Developer only, required: one line of at most 200 characters saying what this run did, posted as a comment on the task, e.g. "Addressed review: dropped idle-thread fixture"'),
  criteria: z.array(criterionVerdict).optional().describe('Reviewer only: a verdict per acceptance criterion'),
  preservesApproval: z.boolean().optional().describe('Reviewer of an epic rebase resolution only, when approving: true only if the approved behaviour is unchanged; false restarts the epic\'s normal review'),
  decision: epicDecisionInput.optional().describe('Epic rebase resolutions only, required with stuck or blocked: the question for the human, with alternatives and the changes affected')
})

// Set by the runner, never the agent. headSha: the commit a developer's run
// pushed, or the one a reviewer's checkout is at. baseSha: where a submitted
// commit forked from its epic branch.
const reportFields = { summary: reportOutcomeInput.shape.summary, note: reportOutcomeInput.shape.note, review: reportOutcomeInput.shape.review, conflictedFiles: reportOutcomeInput.shape.conflictedFiles, preservesApproval: reportOutcomeInput.shape.preservesApproval, decision: reportOutcomeInput.shape.decision, headSha: z.string().optional(), baseSha: z.string().optional() }
const taskReview = <Outcome extends z.ZodType<ReviewVerdict>>(outcome: Outcome) => z.object({ ...reportFields, outcome, criteria: z.array(criterionVerdict, { error: missingCriteria }) })
const nonReview = z.object({ ...reportFields, outcome: NON_REVIEW_OUTCOMES })

export const outcomeReportSchema = z.discriminatedUnion('outcome', [
  taskReview(REVIEW_OUTCOMES), nonReview
], { error: unknownOutcome })

// D24: an approved rebase review carries the earlier approval's verdicts over,
// so it needs none of its own
export const rebaseReviewReportSchema = z.discriminatedUnion('outcome', [
  z.object({ ...reportFields, outcome: z.literal('approved'), criteria: z.array(criterionVerdict).optional() }),
  taskReview(REVIEW_OUTCOMES.exclude(['approved'])), nonReview
], { error: unknownOutcome })

// D23: an integration review judges the whole epic, not one task's criteria
export const epicReviewReportSchema = z.object({
  ...reportFields, outcome: z.enum(REVIEW_VERDICTS, { error: `must be one of ${REVIEW_VERDICTS.join(', ')}` })
})

export type OutcomeReport = z.infer<typeof outcomeReportSchema> | z.infer<typeof rebaseReviewReportSchema>
export type EpicReviewReport = z.infer<typeof epicReviewReportSchema>

// ── Messages ─────────────────────────────────────────────────────────────────

export type RunnerMessage = z.infer<typeof runnerMessageSchema>

export type ServerMessage = z.infer<typeof serverMessageSchema>

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

// Integration protocol is negotiated independently of the WebSocket envelope.
// Omission means legacy only; do not advertise execution before implementing it.
export const TASK_INTEGRATION_PROTOCOL = 1
export function integrationCompatibilityReason(required: number, supported: readonly number[] = []): string | null {
  return required === 0 || supported.includes(required)
    ? null
    : `Task requires integration protocol ${required}. Update the runner to a build supporting PR-free epic task integration; legacy PR work remains available.`
}

export interface RunnerInfo extends RunnerCapacity {
  taskIntegrationProtocols?: number[]
  // Runs integration jobs; a runner that only submits and reviews doesn't
  taskIntegrationExecutor?: boolean
  // Runs epic_rebase jobs
  epicRebaseExecutor?: boolean
  integrationCompatibilityReason?: string | null
  activeRunCount?: number
  updateState?: string
  updateError?: string
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

// Runtime boundaries: unknown fields are ignored for forward compatibility.
export const repoSummarySchema = z.object({ nameWithOwner: z.string(), description: z.union([z.string(), z.null()]), isPrivate: z.boolean(), updatedAt: z.string(), defaultBranch: z.string(), canPush: z.boolean() })

export const setupJobSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list_repos') }),
  z.object({ kind: z.literal('check_repo'), repository: z.string() }),
  z.object({ kind: z.literal('detect_clis') }),
  z.object({ kind: z.literal('github'), method: z.union([z.literal('GET'), z.literal('POST'), z.literal('PUT'), z.literal('PATCH'), z.literal('DELETE')]), path: z.string(), body: z.unknown().optional() }),
  z.object({ kind: z.literal('cleanup_worktrees'), repository: z.string(), taskId: z.string() }),
  // PR-free integration (D27). Prepare builds one commit from a reviewed
  // submission on top of the expected epic head, touching no shared ref; push
  // advances the epic branch only if it's still at that head; inspect reads the
  // remote. submissionId is written into the commit, so the remote itself says
  // whether a submission landed. candidateRef: where to publish the candidate
  // for CI, when the project has required checks.
  z.object({ kind: z.literal('integration_prepare'), repository: z.string(), targetBranch: z.string(), expectedTargetSha: z.string(), submissionId: z.string(), headSha: z.string(), baseSha: z.string(), message: z.string(), committedAt: z.string(), candidateRef: z.string().nullable() }),
  z.object({ kind: z.literal('integration_push'), repository: z.string(), targetBranch: z.string(), expectedTargetSha: z.string(), candidateSha: z.string() }),
  z.object({ kind: z.literal('integration_inspect'), repository: z.string(), targetBranch: z.string(), submissionId: z.string() }),
  // Epic synchronization (D27). Prepare rebases the expected epic head onto a
  // target commit without touching a shared ref. Push checks the candidate
  // keeps the target's work, then advances the epic branch only if it's still
  // at the expected head.
  z.object({ kind: z.literal('epic_rebase_prepare'), repository: z.string(), epicBranch: z.string(), expectedHeadSha: z.string(), ontoSha: z.string() }),
  z.object({ kind: z.literal('epic_rebase_push'), repository: z.string(), epicBranch: z.string(), targetBranch: z.string(), expectedHeadSha: z.string(), ontoSha: z.string(), candidateSha: z.string() }),
  // Remove every worktree outside this keep set, which covers all projects.
  // Developer worktrees with uncommitted work stay (PRD §7.4), and so does the
  // checkout of a PM turn running on the runner.
  z.object({ kind: z.literal('sweep_worktrees'), keepTaskIds: z.array(z.string()), keepPlanSessionIds: z.array(z.string()) }),
  z.object({ kind: z.literal('session_title'), prompt: z.string() }),
  z.object({ kind: z.literal('inbox_message'), prompt: z.string() }),
  z.object({ kind: z.literal('release_notes'), runtime: z.string(), prompt: z.string() })
])

export const setupJobResultSchema = z.discriminatedUnion('kind', [
  z.discriminatedUnion('signedIn', [
    z.object({ kind: z.literal('list_repos'), signedIn: z.literal(false) }),
    z.object({ kind: z.literal('list_repos'), signedIn: z.literal(true), repos: z.array(repoSummarySchema) })
  ]),
  z.object({ kind: z.literal('check_repo'), signedIn: z.boolean(), found: z.boolean(), canPush: z.boolean(), defaultBranch: z.string().nullable(), cloned: z.boolean(), error: z.string().nullable() }),
  z.object({ kind: z.literal('detect_clis'), clis: z.array(z.object({ id: z.enum(['claude', 'codex']), version: z.string().nullable(), signedIn: z.boolean() })) }),
  z.object({ kind: z.literal('github'), status: z.number(), body: z.unknown() }),
  z.object({ kind: z.literal('cleanup_worktrees'), removed: z.array(z.string()), kept: z.array(z.string()) }),
  z.object({ kind: z.literal('integration_prepare'), status: z.enum(['prepared', 'integrated', 'moved', 'conflict', 'empty', 'failed']), targetSha: z.string(), commitSha: z.string().nullable(), files: z.array(z.string()), error: z.string().nullable().optional() }),
  z.object({ kind: z.literal('integration_push'), pushed: z.boolean(), error: z.string().nullable() }),
  z.object({ kind: z.literal('integration_inspect'), targetSha: z.string().nullable(), integratedSha: z.string().nullable() }),
  z.object({ kind: z.literal('epic_rebase_prepare'), status: z.enum(['rebased', 'up_to_date', 'moved', 'conflict', 'failed']), commitSha: z.string().nullable(), files: z.array(z.string()), error: z.string().optional() }),
  // `rejected`: the candidate itself is wrong, and nothing was pushed
  z.object({ kind: z.literal('epic_rebase_push'), pushed: z.boolean(), rejected: z.string().nullable(), error: z.string().nullable() }),
  // `kept` is only what stayed because it holds uncommitted changes
  z.object({ kind: z.literal('sweep_worktrees'), removed: z.array(z.string()), kept: z.array(z.string()) }),
  z.object({ kind: z.literal('session_title'), title: z.string() }),
  z.object({ kind: z.literal('inbox_message'), message: z.string() }),
  z.object({ kind: z.literal('release_notes'), notes: z.string() })
])

export const runEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('system'), text: z.string() }),
  z.object({ type: z.literal('message'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  // Tool inputs are runtime-specific JSON, validated by the tool boundary.
  z.object({ type: z.literal('tool_call'), id: z.string(), tool: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool_result'), id: z.string(), output: z.string(), isError: z.boolean() }),
  z.object({ type: z.literal('usage'), inputTokens: z.number(), cacheReadTokens: z.number(), outputTokens: z.number() })
])

export const runExitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exited'), code: z.union([z.number(), z.null()]) }),
  z.object({ kind: z.literal('stopped'), reason: z.string().optional() }),
  z.object({ kind: z.literal('timed_out'), limitSeconds: z.number().optional() }),
  z.object({ kind: z.literal('runner_shutdown') }),
  z.object({ kind: z.literal('signalled'), signal: z.string() }),
  z.object({ kind: z.literal('rate_limited'), resetsAt: z.union([z.string(), z.null()]) }),
  z.object({ kind: z.literal('error'), message: z.string() })
])

export const agentToolSchema = z.enum([
  'get_task', 'add_comment', 'attach_evidence', 'get_evidence', 'get_attachment',
  'get_design', 'submit_design', 'report_outcome', 'list_tasks', 'get_run_outcomes', 'get_agent_activity', 'list_runs', 'get_run',
  'ask_question', 'propose_plan', 'approve_plan', 'flag_stale_docs'
])

// A malformed source reads as missing, as from a runner without resource-based sizing.
export const slotSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('explicit') }),
  z.object({ kind: z.literal('derived'), cpus: z.number(), memoryBytes: z.number(), slotCpus: z.number(), slotMemoryBytes: z.number() })
])

export const runnerHelloSchema = z.object({ type: z.literal('hello'), protocol: z.number(), taskIntegrationProtocols: z.array(z.number().int().positive()).optional(), taskIntegrationExecutor: z.boolean().optional(), epicRebaseExecutor: z.boolean().optional(), commit: z.string().default('unknown'), updateTarget: z.string().optional(), updateState: z.string().optional(), updateError: z.string().optional(), draining: z.boolean().optional(), updateRequested: z.boolean().optional(), autoUpdate: z.boolean().optional(), runnerId: z.string(), name: z.string(), activeRuns: z.array(z.object({ runId: z.string(), leaseEpoch: z.number() })), slotSource: slotSourceSchema.optional().catch(undefined), slots: z.number().optional(), runtimes: z.array(z.string()).optional(), roles: z.array(z.enum(RUNNER_ROLES)).optional() })

// Pre-capacity/build hello packets must still get the protocol-version refusal.
// This schema is used only for rejecting a different version, never admission.
export const legacyRunnerHelloSchema = runnerHelloSchema.extend({
  name: z.string().default(''), activeRuns: z.array(z.object({ runId: z.string(), leaseEpoch: z.number() })).default([])
})

export const runnerMessageSchema = z.discriminatedUnion('type', [
  runnerHelloSchema,
  z.object({ type: z.literal('runner.draining'), updateRequested: z.boolean() }),
  z.object({ type: z.literal('runner.update-status'), draining: z.boolean(), updateRequested: z.boolean(), activeRunCount: z.number(), updateState: z.string().optional(), updateError: z.string().optional() }),
  z.object({ type: z.literal('heartbeat'), sentAt: z.number().optional(), activeRuns: z.array(z.object({ runId: z.string(), leaseEpoch: z.number() })) }),
  z.discriminatedUnion('ok', [
    z.object({ type: z.literal('job.result'), jobId: z.string(), ok: z.literal(true), result: setupJobResultSchema }),
    z.object({ type: z.literal('job.result'), jobId: z.string(), ok: z.literal(false), error: z.string() })
  ]),
  z.object({ type: z.literal('run.started'), sentAt: z.number().optional(), runId: z.string(), leaseEpoch: z.number(), agentSessionId: z.union([z.string(), z.null()]) }),
  z.object({ type: z.literal('run.events'), runId: z.string(), leaseEpoch: z.number(), events: z.array(runEventSchema) }),
  // wipSha: the commit that saved a stopped developer run's work, once pushed
  z.object({ type: z.literal('run.ended'), runId: z.string(), leaseEpoch: z.number(), exit: runExitSchema, headSha: z.union([z.string(), z.null()]), lastActivityAt: z.union([z.string(), z.null()]).optional(), wipSha: z.union([z.string(), z.null()]).optional(), timings: runTimingsSchema.optional() }),
  z.object({ type: z.literal('tool.call'), callId: z.string(), runId: z.string(), leaseEpoch: z.number(), tool: agentToolSchema, input: z.unknown() }),
  z.object({ type: z.literal('run.message.rejected'), runId: z.string(), leaseEpoch: z.number(), text: z.string(), error: z.string() })
])

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), integrationCompatibilityReason: z.string().nullable().optional(), runnerId: z.string(), commit: z.string(), draining: z.boolean(), updateRequested: z.boolean() }),
  // A short-lived acknowledgement of a live lease; expired acknowledgements never authorise a WIP push.
  z.object({ type: z.literal('run.lease'), runId: z.string(), leaseEpoch: z.number(), validUntil: z.string() }),
  z.object({ type: z.literal('runner.drain'), updateRequested: z.boolean() }),
  z.object({ type: z.literal('job.request'), jobId: z.string(), job: setupJobSchema }),
  z.object({ type: z.literal('run.assign'), job: runJobSchema }),
  // keepWork: a developer run saves and pushes its uncommitted work. Only for
  // a stop the task will be retried after: without it nothing is pushed, so a
  // revoked run never pushes; local stops also require a recent lease acknowledgement.
  z.object({ type: z.literal('run.stop'), runId: z.string(), reason: z.string(), keepWork: z.boolean().optional() }),
  z.object({ type: z.literal('run.message'), runId: z.string(), leaseEpoch: z.number(), text: z.string() }),
  z.discriminatedUnion('ok', [
    z.object({ type: z.literal('tool.result'), callId: z.string(), ok: z.literal(true), result: z.unknown() }),
    z.object({ type: z.literal('tool.result'), callId: z.string(), ok: z.literal(false), error: z.string() })
  ])
])

// Deliberately omit payloads: tool inputs and prompts can contain private data.
export function protocolMessageType(value: unknown): string {
  return value !== null && typeof value === 'object' && 'type' in value && typeof value.type === 'string'
    ? value.type
    : '<unknown>'
}
