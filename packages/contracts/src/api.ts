import {
  AGENT_ROLES,
  MERGE_METHODS,
  PROJECT_PREFIX_PATTERN,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type Actor,
  type AgentRole,
  type MergeMethod,
  type RunOutcome,
  type RunState,
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

// design/project-settings.md: one PATCH on Save; pause is its own switch
export const patchProjectInput = z.object({
  name: z.string().trim().min(1).optional(),
  prefix: z.string().regex(PROJECT_PREFIX_PATTERN, 'Use 2–5 letters, A–Z').optional(),
  thumbnailColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  defaultBranch: z.string().trim().min(1).optional(),
  mergeMethod: z.enum(MERGE_METHODS).optional(),
  requiredChecks: z.array(z.string().trim().min(1)).optional(),
  paused: z.boolean().optional(),
  humanReviewDefault: z.boolean().optional(),
  reviewRoundCap: z.number().int().positive().optional(),
  failedRunCap: z.number().int().positive().optional()
})
export type PatchProjectInput = z.infer<typeof patchProjectInput>

// design/project-settings.md, Danger zone: the human types the project name
export const deleteProjectInput = z.object({ confirm: z.string() })
export type DeleteProjectInput = z.infer<typeof deleteProjectInput>

export interface Project {
  id: string
  name: string
  slug: string
  prefix: string
  thumbnailColor: string | null
  nextTaskNumber: number
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

// ── Epics ───────────────────────────────────────────────────────────────────

// A group of tasks, usually one approved plan. The description is markdown.
export interface Epic {
  id: string
  projectId: string
  title: string
  description: string
  // Tasks outside Draft, and how many of them are merged
  taskCount: number
  mergedCount: number
  createdAt: string
  updatedAt: string
}

// The epic with every task in it, Drafts included, for the dependency canvas
export interface EpicDetail extends Epic {
  tasks: Task[]
}

export const patchEpicInput = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().optional()
})
export type PatchEpicInput = z.infer<typeof patchEpicInput>

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

// design/task.md: a PATCH per field, saved as you go
export const patchTaskInput = z.object({
  title: z.string().trim().min(1).optional(),
  description: richTextDocument.nullable().optional(),
  priority: z.enum(TASK_PRIORITIES).optional(),
  type: z.enum(TASK_TYPES).optional(),
  epicId: z.uuid().nullable().optional(),
  humanReview: z.boolean().optional(),
  // Replaces the list; existing criteria keep their IDs when their text is unchanged
  acceptanceCriteria: z.array(z.object({ id: z.uuid().optional(), text: z.string().trim().min(1) })).optional(),
  // Task numbers in the same project; replaces the list
  dependsOn: z.array(z.number().int().positive()).optional()
})
export type PatchTaskInput = z.infer<typeof patchTaskInput>

export const addCommentInput = z.object({
  body: z.string().trim().min(1),
  pinned: z.boolean().default(false)
})

export interface Comment {
  id: string
  taskId: string
  author: Actor
  body: string
  pinned: boolean
  createdAt: string
}

export interface AuditEntry {
  id: number
  projectId: string | null
  taskId: string | null
  actor: Actor
  action: string
  detail: Record<string, unknown>
  createdAt: string
}

export const taskListQuery = z.object({
  // Board shows everything but Backlog; the Backlog view shows only Backlog (D10)
  view: z.enum(['board', 'backlog', 'all']).default('all')
})

// The transitions a human can ask for over HTTP (D10). Everything else is
// triggered by the server or scheduler.
export const humanTransitionInput = z.discriminatedUnion('type', [
  z.object({ type: z.literal('approve') }),
  z.object({ type: z.literal('accept') }),
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
  // `met` comes from the latest review of the current commit (design/task.md)
  acceptanceCriteria: { id: string, position: number, text: string, met: boolean | null }[]
  // Refs of the tasks this one waits on
  dependsOn: string[]
  lease: Lease | null
  // The commit last submitted for review
  headSha: string | null
  latestReview: Review | null
  mergeCommitSha: string | null
  mergedAt: string | null
  // Required checks seen passing when the task reached Human review
  gateChecks: { name: string, url: string | null }[] | null
  createdAt: string
  updatedAt: string
}

// ── Plan (D9, design/plan.md) ─────────────────────────────────────────────

export interface PlanSession {
  id: string
  projectId: string
  title: string
  preview: string
  unread: boolean
  // What the human has to do here, if anything
  status: 'needs_approval' | 'question' | 'none'
  // Set while a PM turn is running
  activeRunId: string | null
  createdAt: string
  updatedAt: string
}

export interface PlanMessage {
  id: string
  sessionId: string
  role: 'human' | 'pm'
  kind: 'message' | 'question' | 'error'
  text: string
  planId: string | null
  runId: string | null
  createdAt: string
}

export type PlanChange = 'added' | 'changed' | 'unchanged' | 'removed'

export interface Plan {
  id: string
  sessionId: string
  projectId: string
  epicId: string | null
  version: number
  title: string
  summary: string
  status: 'proposed' | 'approved' | 'superseded'
  approvedAt: string | null
  // In the order the PM gave them; epicId above is the first
  epics: { key: string, id: string, title: string }[]
  tasks: {
    key: string
    change: PlanChange
    // True when the plan revises an existing task rather than adding a new
    // one; its edits are staged until approval
    revises: boolean
    taskId: string | null
    epicId: string | null
    ref: string | null
    title: string
    status: TaskStatus | null
    criteriaCount: number
    dependsOn: string[]
  }[]
  createdAt: string
}

export interface PlanSessionDetail extends PlanSession {
  messages: PlanMessage[]
  plans: Plan[]
}

export const startPlanSessionInput = z.object({
  projectId: z.uuid(),
  text: z.string().trim().default(''),
  // "Refine a task": a Backlog task ref attached to the message
  taskRef: z.string().trim().optional()
}).refine(input => input.text.length > 0 || input.taskRef, { message: 'Write a message or attach a task' })
export type StartPlanSessionInput = z.infer<typeof startPlanSessionInput>

export const planMessageInput = z.object({
  text: z.string().trim().default(''),
  taskRef: z.string().trim().optional()
}).refine(input => input.text.length > 0 || input.taskRef, { message: 'Write a message or attach a task' })
export type PlanMessageInput = z.infer<typeof planMessageInput>

// The plan's Drafts go to the board (Ready) or to the Backlog
export const approvePlanInput = z.object({
  to: z.enum(['ready', 'backlog']).default('ready')
})
export type ApprovePlanInput = z.input<typeof approvePlanInput>

// ── Inbox (D11, design/inbox.md) ───────────────────────────────────────────

export type InboxItemType = 'human_review' | 'question' | 'blocked' | 'failed' | 'activity'

export interface InboxItem {
  // The task ID for Needs-you items; the audit entry for Activity and Resolved
  id: string
  type: InboxItemType
  project: { id: string, slug: string, name: string, thumbnailColor: string | null }
  taskId: string
  taskRef: string
  subject: string
  preview: string
  body: string
  sender: { name: string, role: AgentRole | 'system' }
  at: string
  prUrl: string | null
  // Set on Resolved items: what the human did
  resolution: string | null
}

export interface Inbox {
  needsYou: InboxItem[]
  activity: InboxItem[]
  resolved: InboxItem[]
}

// What the human can do from an item's tray (design/inbox.md, D10)
export const inboxActionInput = z.discriminatedUnion('action', [
  // Blocked: answer the question or clarify, and continue In progress
  z.object({ action: z.literal('clarify'), text: z.string().trim().min(1) }),
  z.object({ action: z.literal('send_back') }),
  // Failed or Blocked: resolve to a status (D10)
  z.object({ action: z.literal('resolve'), to: z.enum(['backlog', 'ready', 'in_progress']), text: z.string().trim().optional() }),
  // Human review
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('request_changes'), text: z.string().trim().min(1) }),
  z.object({ action: z.literal('delete'), text: z.string().trim().optional() })
])
export type InboxActionInput = z.infer<typeof inboxActionInput>

// ── Control panel (PRD §7.11) ────────────────────────────────────────────────

export interface GlobalStatus {
  // The kill switch: no runs start and running ones are stopped
  stopped: boolean
  // Held for a redeploy: nothing new starts, running work finishes
  updating: boolean
}

export const patchAgentInput = z.object({
  name: z.string().trim().min(1).optional(),
  concurrency: z.number().int().positive().optional(),
  paused: z.boolean().optional()
})
export type PatchAgentInput = z.infer<typeof patchAgentInput>

// ── Errors ──────────────────────────────────────────────────────────────────

export type ApiError =
  | { code: 'not_found' }
  | { code: 'invalid_input', issues: unknown }
  | { code: 'conflict', constraint: string | null }
  | { code: 'transition_rejected', reason: TransitionError }
  | { code: 'invalid_dependencies', problems: unknown }
  | { code: 'runner_offline' }
  | { code: 'corral_updating' }

export interface ApiErrorBody {
  error: ApiError
}

// Kept here so web can label roles and statuses without importing core
export { AGENT_ROLES, TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES }

// ── Setup (onboarding step 2 and 3, add project) ────────────────────────────

export interface RepoChoice {
  nameWithOwner: string
  description: string | null
  isPrivate: boolean
  updatedAt: string
  defaultBranch: string
  // Shown but disabled: read-only access, or already a project (D13)
  selectable: boolean
  reason: 'read_only' | 'used_by_project' | null
  usedBy: { slug: string, name: string } | null
}

export type RepoList =
  | { signedIn: false }
  | { signedIn: true, repos: RepoChoice[], fetchedAt: string }

export const checkRepoInput = z.object({ repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/) })

export interface SetupCheck {
  id: 'can_push' | 'not_used' | 'cloned'
  ok: boolean
  title: string
  detail: string
}

export interface RepoCheck {
  repository: string
  defaultBranch: string | null
  checks: SetupCheck[]
  // Every check passed, so a project can be created
  ready: boolean
}

export interface CliStatus {
  id: 'claude'
  name: string
  version: string | null
  signedIn: boolean
}

// ── Agents and runs ─────────────────────────────────────────────────────────

export interface Agent {
  id: string
  name: string
  role: AgentRole
  runtime: string
  concurrency: number
  paused: boolean
  // Set while waiting out a usage limit (D3)
  pausedUntil: string | null
  // Runs holding a lease right now
  activeRuns: number
  // The profile picture, or null for initials
  avatarUrl: string | null
}

// The human using Corral. The name shown in the app still comes from the
// browser (design/settings.md); the picture is kept on the server.
export interface Profile {
  id: string
  avatarUrl: string | null
}

// Profile pictures: small square images, resized in the browser before upload
export const AVATAR_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024

export interface Run {
  id: string
  // Shown as #128
  number: number
  agentId: string
  agentName: string
  role: AgentRole
  projectId: string
  taskId: string | null
  taskRef: string | null
  taskTitle: string | null
  state: RunState
  outcome: RunOutcome | null
  summary: string | null
  error: string | null
  headSha: string | null
  inputTokens: number | null
  outputTokens: number | null
  rateLimitResetAt: string | null
  queuedAt: string
  startedAt: string | null
  endedAt: string | null
}

export interface Evidence {
  id: string
  taskId: string
  criterionId: string | null
  runId: string
  round: number
  kind: EvidenceKind
  note: string
  fileName: string
  contentType: string
  size: number
  // Served by the server (D8: web never touches storage)
  url: string
  createdAt: string
}

export type ReviewVerdict = 'approved' | 'changes_requested'

export interface Review {
  id: string
  taskId: string
  runId: string
  round: number
  headSha: string
  verdict: ReviewVerdict
  summary: string
  criteria: { criterionId: string, met: boolean, note: string }[]
  author: Actor
  createdAt: string
}

export const EVIDENCE_KINDS = ['screenshot', 'video', 'test_output', 'log', 'request', 'text', 'other'] as const
export type EvidenceKind = typeof EVIDENCE_KINDS[number]
