import {
  AGENT_ROLES,
  MERGE_METHODS,
  PROJECT_PREFIX_PATTERN,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type AgentRole,
  type MergeMethod,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
  type TransitionError
} from '@corral/core'
import { z } from 'zod'

// HTTP API between apps/web and apps/server. Inputs are zod schemas the server
// validates; outputs are plain types (JSON, so dates are ISO strings).

// ── Projects ────────────────────────────────────────────────────────────────

export const createProjectInput = z.object({
  name: z.string().trim().min(1),
  // Derived from the name when left out
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  prefix: z.string().regex(PROJECT_PREFIX_PATTERN, 'Use 2–5 letters, A–Z'),
  // GitHub owner/name
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  defaultBranch: z.string().trim().min(1),
  mergeMethod: z.enum(MERGE_METHODS).optional(),
  humanReviewDefault: z.boolean().optional()
})
export type CreateProjectInput = z.infer<typeof createProjectInput>

export interface Project {
  id: string
  name: string
  slug: string
  prefix: string
  repository: string
  defaultBranch: string
  mergeMethod: MergeMethod
  requiredChecks: string[]
  paused: boolean
  humanReviewDefault: boolean
  reviewRoundCap: number
  failedRunCap: number
  createdAt: string
  updatedAt: string
}

// ── Tasks ───────────────────────────────────────────────────────────────────

// A ProseMirror/TipTap document from the editor; its inner shape is the editor's business
export const richTextDocument = z.looseObject({ type: z.literal('doc') })

export const createTaskInput = z.object({
  title: z.string().trim().min(1),
  description: richTextDocument.nullable().default(null),
  type: z.enum(TASK_TYPES),
  priority: z.enum(TASK_PRIORITIES).default('medium'),
  epicId: z.uuid().nullable().default(null),
  // Defaults to the project's setting (D5)
  humanReview: z.boolean().optional(),
  acceptanceCriteria: z.array(z.string().trim().min(1)).default([]),
  // Task numbers in the same project
  dependsOn: z.array(z.number().int().positive()).default([])
})
export type CreateTaskInput = z.input<typeof createTaskInput>

export const taskListQuery = z.object({
  // Board shows everything but Backlog; the Backlog view shows only Backlog (D10)
  view: z.enum(['board', 'backlog', 'all']).default('all')
})

// The transitions a human can ask for over HTTP (D10). Everything else is
// triggered by the server or scheduler.
export const humanTransitionInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approve') }),
  z.object({ type: z.literal('send_back') }),
  z.object({ type: z.literal('human_request_changes') }),
  z.object({ type: z.literal('resolve'), to: z.enum(['backlog', 'ready', 'in_progress']) })
])
export type HumanTransitionInput = z.infer<typeof humanTransitionInput>

export interface Lease {
  runId: string
  role: AgentRole
  expiresAt: string
}

export interface Task {
  id: string
  projectId: string
  // PREFIX-NUMBER, e.g. COR-29 (D13)
  ref: string
  number: number
  title: string
  description: unknown
  status: TaskStatus
  priority: TaskPriority
  type: TaskType
  epicId: string | null
  humanReview: boolean
  reviewRounds: number
  failedRuns: number
  statusReason: string | null
  paused: boolean
  branch: string | null
  prNumber: number | null
  prUrl: string | null
  acceptanceCriteria: { id: string, position: number, text: string }[]
  // Refs of the tasks this one waits on
  dependsOn: string[]
  lease: Lease | null
  createdAt: string
  updatedAt: string
}

// ── Errors ──────────────────────────────────────────────────────────────────

export type ApiError =
  | { code: 'not_found' }
  | { code: 'invalid_input', issues: unknown }
  | { code: 'conflict', constraint: string | null }
  | { code: 'transition_rejected', reason: TransitionError }
  | { code: 'invalid_dependencies', problems: unknown }

export interface ApiErrorBody {
  error: ApiError
}

// Kept here so web can label roles and statuses without importing core
export { AGENT_ROLES, TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES }
