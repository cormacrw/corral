import { CLI_IDS, RUN_PHASES, TASK_TYPES, type RunTimings } from '@corral/core'
import { z } from 'zod'
import { RUNNER_ROLES } from './runner-status.ts'
import { agentToolSchema } from './tool-definitions.ts'
import { COMPATIBLE_TOOL_CONTRACTS } from './wire-compat.ts'

// The protocol between apps/server and apps/runner over WebSocket (D7). The
// runner always dials out (D1), so the same messages work on localhost, the
// Docker network (D12) and a hosted server later. Messages are JSON.

// 4: global PM jobs have a null projectId and no repository checkout (COR-242)
// 3: build identity and drain state (COR-187)
// 2: hello carries the runner's slots, runtimes and roles (COR-184)
export const RUNNER_PROTOCOL_VERSION = 4
export const RUNNER_HEARTBEAT_MS = 30_000
export const RUNNER_PATH = '/runner'
// Both ends of the runner socket refuse a larger message by closing the
// connection, and with it every run on that runner
export const RUNNER_MAX_MESSAGE_BYTES = 100 * 1024 * 1024

// Why the server closed a runner's socket. `protocol` carries a
// RunnerRefusal as its reason, so the runner knows what to update to.
export const RUNNER_CLOSE_CODES = { protocol: 4000, replaced: 4001, noHeartbeat: 4002, token: 4003 } as const

const runnerRefusalSchema = z.object({ protocol: z.number(), commit: z.string() })
export type RunnerRefusal = z.infer<typeof runnerRefusalSchema>

// Older servers may only send a readable protocol error
export function parseRunnerRefusal(reason: string): RunnerRefusal | null {
  try {
    return runnerRefusalSchema.safeParse(JSON.parse(reason)).data ?? null
  } catch {
    return null
  }
}

// ── Setup jobs: short requests that return data and change nothing on GitHub
// except where the server asks it to through `github` ─────────────────────────

export type RepoSummary = z.infer<typeof repoSummarySchema>

export type SetupJob = z.infer<typeof setupJobSchema>

export type SetupJobResult = z.infer<typeof setupJobResultSchema>

// What a developer run should check locally: `targeted` when required CI covers
// the full gates, `none` for an epic rebase, and absent for the full check. The
// runner hands it to the agent's process as CORRAL_CHECK_SCOPE.
const CHECK_SCOPES = ['targeted', 'none'] as const
export type CheckScope = (typeof CHECK_SCOPES)[number]

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
  continueFrom: z.string().nullish(),
  checkScope: z.enum(CHECK_SCOPES).nullish()
}
const pmRunJobSchema = z.object({
  ...runJobCommon, projectId: z.string().nullable(), role: z.literal('pm'), planSessionId: z.string().min(1),
  taskId: z.null(), taskRef: z.null(), branch: z.null(), headSha: z.null(),
  baseBranch: z.never().optional(), epicId: z.never().optional(),
  taskType: z.null().optional(), designPinned: z.never().optional(), continueFrom: z.never().optional()
})
const developerRunJobSchema = z.object({ ...runJobCommon, ...taskJobContext, role: z.literal('developer') })
const reviewerRunJobSchema = z.object({ ...runJobCommon, ...taskJobContext, role: z.literal('reviewer') })
// D20 designers have their own role and only ever author design tasks.
const designerRunJobSchema = z.object({ ...runJobCommon, ...taskJobContext, role: z.literal('designer'), taskType: z.literal('design') })
// D23 integration reviews target an epic rather than pretending it is a task.
const epicReviewerRunJobSchema = z.object({
  ...runJobCommon, role: z.literal('reviewer'), taskId: z.null(), taskRef: z.null(),
  epicId: z.string().min(1), branch: z.string().min(1), headSha: z.string().min(1),
  baseBranch: z.string().optional(), planSessionId: z.null(),
  taskType: z.never().optional(), designPinned: z.never().optional(), continueFrom: z.never().optional()
})
// D29 a developer keeping an epic PR healthy works on a candidate branch of the
// operation that holds the epic's writer lock, with no task.
const epicDeveloperRunJobSchema = z.object({
  ...runJobCommon, role: z.literal('developer'), taskId: z.null(), taskRef: z.null(),
  epicId: z.string().min(1), branch: z.string().min(1), headSha: z.string().min(1),
  baseBranch: z.string().optional(), planSessionId: z.null(),
  taskType: z.never().optional(), designPinned: z.never().optional(), continueFrom: z.string().nullish(),
  checkScope: z.enum(CHECK_SCOPES).nullish()
})
export const runJobSchema = z.union([
  z.discriminatedUnion('role', [pmRunJobSchema, developerRunJobSchema, designerRunJobSchema, reviewerRunJobSchema]),
  epicReviewerRunJobSchema, epicDeveloperRunJobSchema
])
export type RunJob = z.infer<typeof runJobSchema>
export type PmRunJob = z.infer<typeof pmRunJobSchema>

// A PM thread outside any project: no repository checkout (COR-242)
export function isGlobalPmJob(job: Pick<RunJob, 'role' | 'projectId'>): boolean {
  return job.role === 'pm' && job.projectId === null
}

// Structured run events, in the runtime-neutral shape web shows (rule 7)
export type RunEvent = z.infer<typeof runEventSchema>

const runTimingsSchema = z.object({
  totalMs: z.number(),
  phases: z.array(z.object({ phase: z.enum(RUN_PHASES), durationMs: z.number() })),
  tools: z.array(z.object({ tool: z.string(), count: z.number(), totalMs: z.number(), maxMs: z.number() }))
}) satisfies z.ZodType<RunTimings>

export type RunExit = z.infer<typeof runExitSchema>

export type RunnerMessage = z.infer<typeof runnerMessageSchema>

export type ServerMessage = z.infer<typeof serverMessageSchema>

// Integration protocol is negotiated independently of the WebSocket envelope.
// Omission means legacy only; do not advertise execution before implementing it.
export const TASK_INTEGRATION_PROTOCOL = 1
export function integrationCompatibilityReason(required: number, supported: readonly number[] = []): string | null {
  return required === 0 || supported.includes(required)
    ? null
    : `Task requires integration protocol ${required}. Update the runner to a build supporting PR-free subtask integration; legacy PR work remains available.`
}

// Why a runner gets no new runs because its agent tools aren't the server's, or
// null when they match. Missing means a runner older than the check, which is
// a difference too: nothing says its tools match (COR-435).
export function toolContractReason(runner: string | undefined, server: string): string | null {
  if (runner === server || (runner && COMPATIBLE_TOOL_CONTRACTS.includes(runner))) return null
  return `Its agent tools ${runner ? `(${runner})` : '(from before tool contracts)'} differ from the server's (${server}), so it takes no new runs until it has updated.`
}

// Runtime boundaries: unknown fields are ignored for forward compatibility.
const repoSummarySchema = z.object({
  // owner/name
  nameWithOwner: z.string(),
  description: z.union([z.string(), z.null()]),
  isPrivate: z.boolean(),
  updatedAt: z.string(),
  defaultBranch: z.string(),
  // WRITE or above is needed for agents to push and open PRs
  canPush: z.boolean()
})

type CleanupJob = { kind: 'cleanup_worktrees', repository: string } & ({ taskId: string, epicId?: undefined } | { epicId: string, taskId?: undefined })

const setupJobSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('list_repos') }),
  z.object({ kind: z.literal('check_repo'), repository: z.string() }),
  z.object({ kind: z.literal('detect_clis') }),
  z.object({ kind: z.literal('github'), method: z.union([z.literal('GET'), z.literal('POST'), z.literal('PUT'), z.literal('PATCH'), z.literal('DELETE')]), path: z.string(), body: z.unknown().optional(), tailChars: z.number().int().positive().optional() }),
  // An epic's checkouts by epicId. Servers before it sent taskId `epic-<id>`,
  // which names the same folders, so taskId alone still works (D25).
  z.object({ kind: z.literal('cleanup_worktrees'), repository: z.string(), taskId: z.string().optional(), epicId: z.string().optional() })
    .transform((job, ctx): CleanupJob => {
      if (job.taskId !== undefined && job.epicId === undefined) return { kind: job.kind, repository: job.repository, taskId: job.taskId }
      if (job.epicId !== undefined && job.taskId === undefined) return { kind: job.kind, repository: job.repository, epicId: job.epicId }
      ctx.addIssue({ code: 'custom', message: 'Pass taskId or epicId' })
      return z.NEVER
    }),
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
  z.object({ kind: z.literal('epic_rebase_push'), repository: z.string(), epicBranch: z.string(), targetBranch: z.string(), expectedHeadSha: z.string(), ontoSha: z.string(), candidateSha: z.string(), reviewed: z.boolean().optional() }),
  z.object({ kind: z.literal('epic_rebase_inspect'), repository: z.string(), targetBranch: z.string(), expectedHeadSha: z.string(), candidateSha: z.string() }),
  // Remove every worktree outside this keep set, which covers all projects.
  // Developer worktrees with uncommitted work stay (PRD §7.4), and so does the
  // checkout of a PM turn running on the runner.
  z.object({ kind: z.literal('sweep_worktrees'), keepTaskIds: z.array(z.string()), keepPlanSessionIds: z.array(z.string()), keepEpicIds: z.array(z.string()).optional() }),
  z.object({ kind: z.literal('session_title'), prompt: z.string() }),
  z.object({ kind: z.literal('inbox_message'), prompt: z.string() }),
  // A PR's guided review (COR-525): the small model's JSON steps, as text
  z.object({ kind: z.literal('pr_guide'), prompt: z.string() }),
  z.object({ kind: z.literal('release_notes'), runtime: z.string(), prompt: z.string() })
])

const setupJobResultSchema = z.discriminatedUnion('kind', [
  z.discriminatedUnion('signedIn', [
    z.object({ kind: z.literal('list_repos'), signedIn: z.literal(false) }),
    z.object({ kind: z.literal('list_repos'), signedIn: z.literal(true), repos: z.array(repoSummarySchema) })
  ]),
  z.object({ kind: z.literal('check_repo'), signedIn: z.boolean(), found: z.boolean(), canPush: z.boolean(), defaultBranch: z.string().nullable(), cloned: z.boolean(), error: z.string().nullable() }),
  z.object({ kind: z.literal('detect_clis'), clis: z.array(z.object({ id: z.enum(CLI_IDS), version: z.string().nullable(), signedIn: z.boolean() })) }),
  z.object({ kind: z.literal('github'), status: z.number(), body: z.unknown(), failureLines: z.array(z.string()).optional() }),
  z.object({ kind: z.literal('cleanup_worktrees'), removed: z.array(z.string()), kept: z.array(z.string()) }),
  z.object({ kind: z.literal('integration_prepare'), status: z.enum(['prepared', 'integrated', 'moved', 'conflict', 'empty', 'failed']), targetSha: z.string(), commitSha: z.string().nullable(), files: z.array(z.string()), error: z.string().nullable().optional() }),
  z.object({ kind: z.literal('integration_push'), pushed: z.boolean(), error: z.string().nullable() }),
  z.object({ kind: z.literal('integration_inspect'), targetSha: z.string().nullable(), integratedSha: z.string().nullable() }),
  z.object({ kind: z.literal('epic_rebase_prepare'), status: z.enum(['rebased', 'up_to_date', 'moved', 'conflict', 'failed']), commitSha: z.string().nullable(), files: z.array(z.string()), error: z.string().optional() }),
  // `rejected`: the candidate itself is wrong, and nothing was pushed
  z.object({ kind: z.literal('epic_rebase_push'), pushed: z.boolean(), rejected: z.string().nullable(), error: z.string().nullable() }),
  z.object({ kind: z.literal('epic_rebase_inspect'), targetFiles: z.array(z.object({ path: z.string(), diff: z.string(), truncated: z.boolean() })) }),
  // `kept` is only what stayed because it holds uncommitted changes
  z.object({ kind: z.literal('sweep_worktrees'), removed: z.array(z.string()), kept: z.array(z.string()) }),
  z.object({ kind: z.literal('session_title'), title: z.string() }),
  z.object({ kind: z.literal('inbox_message'), message: z.string() }),
  z.object({ kind: z.literal('pr_guide'), text: z.string() }),
  z.object({ kind: z.literal('release_notes'), notes: z.string() })
])

const runEventSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('system'), text: z.string() }),
  z.object({ type: z.literal('message'), text: z.string() }),
  z.object({ type: z.literal('thinking'), text: z.string() }),
  // Tool inputs are runtime-specific JSON, validated by the tool boundary.
  z.object({ type: z.literal('tool_call'), id: z.string(), tool: z.string(), input: z.unknown() }),
  z.object({ type: z.literal('tool_result'), id: z.string(), output: z.string(), isError: z.boolean() }),
  // Only Claude reports cache writes
  z.object({ type: z.literal('usage'), inputTokens: z.number(), cacheWriteTokens: z.number().optional(), cacheReadTokens: z.number(), outputTokens: z.number() })
])

const runExitSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('exited'), code: z.union([z.number(), z.null()]) }),
  z.object({ kind: z.literal('stopped'), reason: z.string().optional() }),
  z.object({ kind: z.literal('timed_out'), limitSeconds: z.number().optional() }),
  z.object({ kind: z.literal('runner_shutdown') }),
  z.object({ kind: z.literal('signalled'), signal: z.string() }),
  z.object({ kind: z.literal('rate_limited'), resetsAt: z.union([z.string(), z.null()]) }),
  z.object({ kind: z.literal('error'), message: z.string() })
])

// A malformed source reads as missing, as from a runner without resource-based sizing.
const slotSourceSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('explicit') }),
  z.object({ kind: z.literal('derived'), cpus: z.number().positive(), memoryBytes: z.number().positive(), slotCpus: z.number().positive(), slotMemoryBytes: z.number().positive() })
])

const runnerHelloSchema = z.object({ type: z.literal('hello'), protocol: z.number(), taskIntegrationProtocols: z.array(z.number().int().positive()).optional(), taskIntegrationExecutor: z.boolean().optional(), epicRebaseExecutor: z.boolean().optional(), epicFixExecutor: z.boolean().optional(), commit: z.string().default('unknown').transform(commit => commit || 'unknown'), updateTarget: z.string().optional(), toolContract: z.string().optional(), updateState: z.string().optional(), updateError: z.string().optional(), draining: z.boolean().optional(), updateRequested: z.boolean().optional(), autoUpdate: z.boolean().optional(), runnerId: z.string(), name: z.string(), activeRuns: z.array(z.object({ runId: z.string(), leaseEpoch: z.number() })), slotSource: slotSourceSchema.optional().catch(undefined), slots: z.number().optional().transform(n => n !== undefined && Number.isInteger(n) && n > 0 ? n : undefined), runtimes: z.array(z.string()).optional(), roles: z.array(z.enum(RUNNER_ROLES)).optional() })

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
  z.object({ type: z.literal('run.started'), initialHeadSha: z.string().nullish(), sentAt: z.number().optional(), runId: z.string(), leaseEpoch: z.number(), agentSessionId: z.union([z.string(), z.null()]), resumeFailed: z.boolean().optional() }),
  z.object({ type: z.literal('run.events'), runId: z.string(), leaseEpoch: z.number(), events: z.array(runEventSchema) }),
  // wipSha: the commit that saved a stopped developer run's work, once pushed
  z.object({ type: z.literal('run.ended'), runId: z.string(), leaseEpoch: z.number(), exit: runExitSchema, headSha: z.union([z.string(), z.null()]), lastActivityAt: z.union([z.string(), z.null()]).optional(), wipSha: z.union([z.string(), z.null()]).optional(), timings: runTimingsSchema.optional() }),
  z.object({ type: z.literal('tool.call'), callId: z.string(), runId: z.string(), leaseEpoch: z.number(), tool: agentToolSchema, input: z.unknown() }),
  z.object({ type: z.literal('run.message.rejected'), runId: z.string(), leaseEpoch: z.number(), text: z.string(), error: z.string() })
])

export const serverMessageSchema = z.discriminatedUnion('type', [
  z.object({ type: z.literal('welcome'), integrationCompatibilityReason: z.string().nullable().optional(), toolContractReason: z.string().nullable().optional(), runnerId: z.string(), commit: z.string(), draining: z.boolean(), updateRequested: z.boolean() }),
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
