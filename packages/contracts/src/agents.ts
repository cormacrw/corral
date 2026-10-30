import {
  ACTIVE_RUN_STATES,
  DESIGNER_RUN_OUTCOMES,
  DEVELOPER_RUN_OUTCOMES,
  PM_RUN_OUTCOMES,
  REVIEWER_RUN_OUTCOMES,
  TERMINAL_RUN_STATES,
  type AgentRole
} from '@corral/core'
import { z } from 'zod'
import { agentRuntime } from './agent-runtimes.ts'
import type { RunnerInfo, RunTimings } from './runner.ts'
import type { Comment } from './tasks.ts'

// ── Control panel (PRD §7.11) ────────────────────────────────────────────────

export interface GlobalStatus {
  // The kill switch: no runs start and running ones are stopped
  stopped: boolean
  // Held for a redeploy: nothing new starts, running work finishes
  updating: boolean
}

export interface ServerStatus extends GlobalStatus {
  runners: RunnerInfo[]
}

// New agents. There is only one PM (D13), so only developers, designers and reviewers.
export const createAgentInput = z.object({
  name: z.string().trim().min(1).max(80),
  role: z.enum(['developer', 'designer', 'reviewer'], { message: 'Only one PM agent exists; the role must be developer, designer or reviewer' }),
  runtime: agentRuntime,
  concurrency: z.number().int().positive().default(1)
})
export type CreateAgentInput = z.infer<typeof createAgentInput>

export const patchAgentInput = z.object({
  name: z.string().trim().min(1).optional(),
  concurrency: z.number().int().positive().optional(),
  paused: z.boolean().optional(),
  // How often the periodic tick may start work for the agent; null for every tick
  wakeIntervalSeconds: z.number().int().positive().nullable().optional(),
  // Only while the agent has no active runs
  runtime: agentRuntime.optional()
})
export type PatchAgentInput = z.infer<typeof patchAgentInput>

// ── Agents and runs ─────────────────────────────────────────────────────────

export interface Agent {
  id: string
  name: string
  role: AgentRole
  runtime: string
  concurrency: number
  paused: boolean
  // The periodic tick starts work for it at most this often; events such as
  // plan approval still start it right away. Null means every tick.
  wakeIntervalSeconds: number | null
  // Set while waiting out a usage limit (D3)
  pausedUntil: string | null
  // Runs holding a lease right now
  activeRuns: number
  // The profile picture, or null for initials
  avatarUrl: string | null
}

// A human's message to a live developer or reviewer run
// (POST /projects/:slug/runs/:runId/messages). Attachments are IDs of images
// uploaded to the project; they're referenced at the end of the text.
export const runMessageInput = z.object({
  text: z.string().trim().min(1).max(20_000),
  attachments: z.array(z.uuid()).max(10).default([])
})
export type RunMessageInput = z.infer<typeof runMessageInput>

// 202 from POST /projects/:slug/runs/:runId/messages: the message went to the
// runner and is kept as the comment. The runner may still turn it down
// (run.message.rejected), which shows in the run's transcript.
export interface RunMessageAccepted {
  runId: string
  comment: Comment
}

// What a run's role, state, outcome and end time may be together, matching the
// checks on the runs table. A run has no outcome or end time until it ends. A
// finished PM turn and an interrupted run have no outcome.
const lifecycleOf = <R extends AgentRole, O extends readonly [string, ...string[]]>(role: R, outcomes: O) => [
  z.object({ role: z.literal(role), state: z.enum(ACTIVE_RUN_STATES), outcome: z.null(), endedAt: z.null() }),
  z.object({ role: z.literal(role), state: z.enum(TERMINAL_RUN_STATES), outcome: z.enum(outcomes).nullable(), endedAt: z.string() })
] as const
export const runLifecycleSchema = z.union([
  ...lifecycleOf('pm', PM_RUN_OUTCOMES),
  ...lifecycleOf('developer', DEVELOPER_RUN_OUTCOMES),
  ...lifecycleOf('designer', DESIGNER_RUN_OUTCOMES),
  ...lifecycleOf('reviewer', REVIEWER_RUN_OUTCOMES)
])
export type RunLifecycle = z.infer<typeof runLifecycleSchema>

export type Run = RunFields & RunLifecycle

interface RunFields {
  timings: RunTimings | null
  runnerId: string | null
  // The runner's name when the run was placed on it
  runnerName: string | null
  id: string
  // Shown as #128
  number: number
  agentId: string
  agentName: string
  // The agent's runtime now; a run doesn't record its own
  agentRuntime: string
  projectId: string
  planSessionId: string | null
  taskId: string | null
  taskRef: string | null
  taskTitle: string | null
  // Set on an epic's integration review, which has no task (D27)
  epicId: string | null
  epicTitle: string | null
  summary: string | null
  review?: import('@corral/core').RebaseReview | null
  conflictedFiles?: string[] | null
  error: string | null
  headSha: string | null
  inputTokens: number | null
  cacheReadTokens: number | null
  outputTokens: number | null
  rateLimitResetAt: string | null
  queuedAt: string
  startedAt: string | null
}
