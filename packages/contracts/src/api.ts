import {
  AGENT_ROLES,
  EPIC_REVIEW_MODES,
  MERGE_METHODS,
  PROJECT_PREFIX_PATTERN,
  richTextIssue,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type Actor,
  type AgentRole,
  type DesignVersionStatus,
  type EpicReviewMode,
  type EpicReviewState,
  type MergeGate,
  type MergeMethod,
  type RunOutcome,
  type RunState,
  type TaskPriority,
  type TaskStatus,
  type TaskType,
  type TransitionError
} from '@corral/core'
import { z } from 'zod'
import type { CliId, RunnerInfo } from './runner.ts'

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
  humanReviewDefault: z.boolean().optional(),
  epicReviewModeDefault: z.enum(EPIC_REVIEW_MODES).optional()
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
  epicReviewModeDefault: z.enum(EPIC_REVIEW_MODES).optional(),
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
  thumbnailUrl: string | null
  nextTaskNumber: number
  repository: string
  defaultBranch: string
  mergeMethod: MergeMethod
  requiredChecks: string[]
  paused: boolean
  humanReviewDefault: boolean
  // The review mode of new epics a plan doesn't give one (D27)
  epicReviewModeDefault: EpicReviewMode
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
  dependsOn: string[]
  blocks: string[]
  reviewMode: EpicReviewMode
  // The epic branch and its PR into the target branch (D27); null until
  // Corral creates them, and always in `direct` mode
  branch: string | null
  prNumber: number | null
  prHeadSha: string | null
  reviewState: EpicReviewState | null
  // Tasks outside Draft and Backlog, and how many of them are merged
  taskCount: number
  mergedCount: number
  createdAt: string
  updatedAt: string
}

// The epic with every task in it, Drafts included, for the dependency canvas
export interface EpicDetail extends Epic {
  tasks: Task[]
}

export const setEpicDependenciesInput = z.object({ dependsOn: z.array(z.uuid()) })
export type SetEpicDependenciesInput = z.infer<typeof setEpicDependenciesInput>

export const patchEpicInput = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().optional()
})
export type PatchEpicInput = z.infer<typeof patchEpicInput>

// ── Tasks ───────────────────────────────────────────────────────────────────

// Structural safety only; semantic Ready checks belong in core.
export const richTextDocument = z.looseObject({ type: z.literal('doc') }).superRefine((doc, ctx) => {
  const issue = richTextIssue(doc)
  if (issue) ctx.addIssue({ code: 'custom', ...issue })
})

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
  z.object({ type: z.literal('human_request_changes'), feedback: z.string().trim().min(1).optional() }),
  z.object({ type: z.literal('resolve'), to: z.enum(['backlog', 'ready', 'in_progress']) })
])
export type HumanTransitionInput = z.infer<typeof humanTransitionInput>

export interface Lease {
  agentId: string
  runId: string
  role: AgentRole
  expiresAt: string
}

export interface TaskAgent {
  id: string
  name: string
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
  // Unfinished prerequisite epics, with titles for display and IDs for links.
  waitingOnEpics: { id: string, title: string }[]
  lease: Lease | null
  // The agents of the task's latest developer and reviewer runs. Tasks aren't
  // assigned ahead of time: a free agent claims them (D15), so these are null
  // until a run of that role exists.
  developer: TaskAgent | null
  reviewer: TaskAgent | null
  // The commit last submitted for review
  headSha: string | null
  latestReview: Review | null
  mergeCommitSha: string | null
  mergedAt: string | null
  // Required checks seen passing when the task reached Human review
  gateChecks: { name: string, url: string | null }[] | null
  // The approved design version a build task builds, and the screens it
  // covers (D20)
  design: TaskDesignPin | null
  // A Draft's Plan session: the session of the latest proposed plan that
  // includes it, so a revision from another session moves it there. Null
  // for every other status.
  planSessionId: string | null
  planSessionTitle: string | null
  createdAt: string
  updatedAt: string
}

export interface TaskDesignPin {
  // The design task, e.g. COR-70
  taskRef: string
  version: number
  screens: string[]
  // A newer approved version of the design, when the task hasn't started:
  // the pin is stale and shows "design changed: v1 → v2" until it's
  // repinned or revised (D20). Null otherwise.
  newerVersion: number | null
}

// A design task's version as the design view shows it (D20). The bundle is
// served sandboxed under previewUrl; screenshots by their own URLs.
export interface DesignVersion {
  id: string
  version: number
  status: DesignVersionStatus
  branch: string
  commitSha: string
  // design.md, as the developer wrote it
  spec: string
  screenshots: { fileName: string, url: string }[]
  previewUrl: string
  // The human's feedback when they requested changes
  feedback: string | null
  // The Plan session approving this version opened for its build
  planSessionId: string | null
  createdAt: string
}

// Approving a design version (D20). The note goes to the PM in the Plan
// session the approval opens.
export const approveDesignInput = z.object({
  note: z.string().trim().max(10_000).optional()
})
export type ApproveDesignInput = z.input<typeof approveDesignInput>

// The runtimes an agent can run on (D15), and the CLI each one needs on the
// runner. Neutral names, never an auth method (agent-runtime-and-auth.md).
export const AGENT_RUNTIMES = { 'claude-code': 'claude', 'codex': 'codex' } as const satisfies Record<string, CliId>
export type AgentRuntime = keyof typeof AGENT_RUNTIMES
// Runtimes whose developer and reviewer runs take messages while they run.
// Codex runs one prompt to the end, so it hears of changes from pinned comments.
export const RUNTIMES_TAKING_MESSAGES: readonly AgentRuntime[] = ['claude-code']
const agentRuntime = z.enum(Object.keys(AGENT_RUNTIMES) as [AgentRuntime, ...AgentRuntime[]], {
  message: `Unknown runtime; use one of ${Object.keys(AGENT_RUNTIMES).join(', ')}`
})

// ── Plan (D9, design/plan.md) ─────────────────────────────────────────────

export interface PlanSession {
  id: string
  projectId: string
  title: string
  // The PM's runtime (D18), e.g. 'claude-code' or 'codex'. Locked once the
  // session has messages.
  runtime: AgentRuntime
  preview: string
  unread: boolean
  // True once its plan is approved, until the human sends another message
  closed: boolean
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
  // Set only on questions, and only when the PM gave them
  recommendation: string | null
  options: string[] | null
  planId: string | null
  runId: string | null
  createdAt: string
}

export type PlanStatus = 'proposed' | 'approved' | 'superseded' | 'discarded'

export type PlanChange = 'added' | 'changed' | 'unchanged' | 'removed'

export interface Plan {
  id: string
  sessionId: string
  projectId: string
  epicId: string | null
  version: number
  title: string
  summary: string
  status: PlanStatus
  approvedAt: string | null
  // In the order the PM gave them; epicId above is the first
  epics: { key: string, id: string, title: string, reviewMode: EpicReviewMode, dependsOn?: { id: string, title: string }[] }[]
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
    priority: TaskPriority
    humanReview: boolean
    dependsOn: string[]
  }[]
  createdAt: string
}

// A project's Drafts by the Plan session they belong to (GET
// /projects/:slug/drafts), newest session first
export interface DraftSession {
  sessionId: string
  title: string
  updatedAt: string
  // The status of the session's latest plan version
  planStatus: PlanStatus | null
  drafts: {
    taskId: string
    ref: string
    title: string
    type: TaskType
    priority: TaskPriority
  }[]
}

export interface PlanSessionDetail extends PlanSession {
  messages: PlanMessage[]
  plans: Plan[]
}

// A client UUID makes a start safe to retry within the same project.
export const startPlanSessionInput = z.object({
  id: z.uuid().optional(),
  projectId: z.uuid(),
  // The PM's runtime for this session (D18); only a CLI the runner has
  runtime: agentRuntime.default('claude-code'),
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

// Only while the session has no messages (D18)
export const patchPlanSessionInput = z.object({
  runtime: agentRuntime
})
export type PatchPlanSessionInput = z.infer<typeof patchPlanSessionInput>

// The PM's ask_question: a question, optionally with a suggested answer
// and 2–5 short answer choices
export const askQuestionInput = z.object({
  question: z.string().trim().min(1),
  recommendation: z.string().trim().min(1).optional().describe('Your suggested answer, in a few words'),
  options: z.array(z.string().trim().min(1, 'An option can’t be empty').max(120, 'An option can be at most 120 characters'))
    .min(2, 'Give 2–5 options, or leave options out').max(5, 'Give 2–5 options, or leave options out')
    .optional().describe('2–5 short answer choices')
})
export type AskQuestionInput = z.infer<typeof askQuestionInput>

// The plan's Drafts go to the board (Ready) or to the Backlog
export const approvePlanInput = z.object({
  to: z.enum(['ready', 'backlog']).default('ready')
})
export type ApprovePlanInput = z.input<typeof approvePlanInput>

// ── Inbox (D11, design/inbox.md) ───────────────────────────────────────────

export type TaskInboxItemType = 'human_review' | 'question' | 'blocked' | 'failed' | 'activity'
export type InboxItemType = TaskInboxItemType | 'plan_thread' | 'epic_review' | 'release_notes'

interface InboxItemBase {
  project: { id: string, slug: string, name: string, thumbnailColor: string | null, thumbnailUrl: string | null }
  subject: string
  preview: string
  sender: { name: string, role: AgentRole | 'system' }
  at: string
}

// An item raised by a developer or reviewer run, about a task
export interface TaskInboxItem extends InboxItemBase {
  // Epic PR activity links to the epic while retaining task context.
  epicId?: string
  body: string
  // The task ID for Needs-you items; the audit entry for Activity and Resolved
  id: string
  type: TaskInboxItemType
  taskId: string
  taskRef: string
  prUrl: string | null
  // Set on Resolved items: what the human did
  resolution: string | null
}

// An open Plan session waiting on the human (D11, amended): a question, a plan
// needing approval or an unread PM reply
export interface PlanThreadItem extends InboxItemBase {
  // The session ID
  id: string
  type: 'plan_thread'
  // Not about a task, so these are always null
  taskId: null
  taskRef: null
  prUrl: null
  resolution: null
  sessionId: string
  runtime: AgentRuntime
  status: PlanSession['status']
  question: Pick<PlanMessage, 'text' | 'recommendation' | 'options'> | null
  // The latest PM message, when the thread is listed only for an unread reply
  reply: string | null
  plan: (Pick<Plan, 'id' | 'version' | 'title' | 'summary'> & { epicCount: number, taskCount: number }) | null
  unread: boolean
  // The plan waiting for approval, when status is needs_approval
  planId: string | null
  // Set while a PM turn is running
  activeRunId: string | null
}

export const epicReviewActionInput = z.object({
  action: z.enum(['approve', 'request_changes']),
  headSha: z.string().min(1),
  text: z.string().trim().optional()
}).refine(input => input.action !== 'request_changes' || Boolean(input.text), { message: 'Describe the changes needed', path: ['text'] })
export type EpicReviewActionInput = z.input<typeof epicReviewActionInput>

export interface EpicReviewItem extends InboxItemBase {
  id: string
  type: 'epic_review'
  epicId: string
  taskId: null
  taskRef: null
  prUrl: string
  body: string
  resolution: null
  headSha: string
  tasks: { task: Task, evidence: Evidence[] }[]
}

export interface ReleaseNotesItem extends InboxItemBase {
  id: string
  type: 'release_notes'
  deploymentId: string
  fromSha: string | null
  toSha: string
  notes: string | null
  notesStatus: Deployment['notesStatus']
  unread: boolean
  taskId: null
  taskRef: null
  prUrl: null
  resolution: string | null
}

export function needsAttention(item: InboxItem): boolean {
  return item.type !== 'release_notes'
}

export type InboxItem = TaskInboxItem | PlanThreadItem | EpicReviewItem | ReleaseNotesItem

export interface Inbox {
  // Attention items newest first, followed by undismissed release notes
  // newest first. Release notes remain here after reading.
  needsYou: InboxItem[]
  activity: TaskInboxItem[]
  resolved: (TaskInboxItem | ReleaseNotesItem)[]
  // The Needs you count excludes informational release notes
  count: number
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

// ── Errors ──────────────────────────────────────────────────────────────────

export type ApiError =
  | { code: 'not_found' }
  // A human-only action attempted by anyone else
  | { code: 'forbidden' }
  | { code: 'invalid_input', issues: unknown }
  | { code: 'conflict', constraint: string | null }
  | { code: 'transition_rejected', reason: TransitionError }
  | { code: 'invalid_dependencies', problems: unknown }
  | { code: 'runner_offline' }
  | { code: 'corral_updating' }
  // PM turns have no concurrency, only one per Plan session (D9, D13)
  | { code: 'concurrency_not_applicable' }
  // A message for a run that can't take one, with a reason a person can read
  | { code: 'run_not_live', reason: string }

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
  id: CliId
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

// The human using Corral. Name and picture are kept on the server, so every
// browser and device sees the same profile (design/settings.md).
export interface Profile {
  id: string
  name: string
  avatarUrl: string | null
}

export const patchProfileInput = z.object({
  name: z.string().trim().min(1).max(80)
})
export type PatchProfileInput = z.infer<typeof patchProfileInput>

// Profile pictures: small square images, resized in the browser before upload
export const AVATAR_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024

// Images in task descriptions and comments. Uploaded as the raw body with
// its content type (POST /projects/:slug/attachments?name=), referenced in
// text as ![name](attachment:<id>) and served from `url`. Never SVG, which
// can carry script.
export const ATTACHMENT_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export type AttachmentContentType = typeof ATTACHMENT_CONTENT_TYPES[number]
export const ATTACHMENT_MAX_BYTES = 10 * 1024 * 1024

export const uploadAttachmentQuery = z.object({
  name: z.string().trim().max(200).optional()
})
export type UploadAttachmentQuery = z.infer<typeof uploadAttachmentQuery>

export interface Attachment {
  id: string
  mimeType: AttachmentContentType
  fileName: string
  byteSize: number
  // /api/attachments/<id>/file
  url: string
}

export interface Run {
  runnerId: string | null
  // The runner's name when the run was placed on it
  runnerName: string | null
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
  cacheReadTokens: number | null
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
  // For a `note`, the text is the evidence and there is no file (D21)
  note: string
  fileName: string | null
  contentType: string | null
  size: number
  // Served by the server (D8: web never touches storage); null for a note
  url: string | null
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

export const EVIDENCE_KINDS = ['screenshot', 'video', 'test_output', 'log', 'request', 'text', 'other', 'note'] as const
export type EvidenceKind = typeof EVIDENCE_KINDS[number]

// ── Pull requests ───────────────────────────────────────────────────────────

// A task's open PR and where it stands against the merge gates, read live
// from GitHub (GET /projects/:slug/pull-requests). `merge` comes from the
// same gate check the merge orchestrator runs before it merges.
export interface PullRequestStatus {
  taskRef: string
  taskTitle: string
  taskStatus: TaskStatus
  pr: { number: number, url: string, state: 'open' | 'closed', headSha: string }
  // The latest verdict on the task, and whether it was for the PR's head
  review: { verdict: ReviewVerdict, headSha: string, forHeadCommit: boolean, createdAt: string } | null
  ci: {
    // Over the project's required checks: any failed, any not passed yet, or all passed
    status: 'passing' | 'failing' | 'pending'
    checks: { name: string, conclusion: CheckConclusion | 'missing', url: string | null }[]
  }
  branch: {
    name: string | null
    // null while GitHub is still computing it
    mergeable: boolean | null
    mergeableState: string | null
    upToDate: boolean
    // 'requested': Corral asked GitHub to update the branch onto the base;
    // 'needed': the base moved on and no update has been asked for yet;
    // 'conflict': GitHub can't merge it, so the developer has to rebase
    rebase: 'not_needed' | 'needed' | 'requested' | 'conflict'
  }
  evidenceComplete: boolean
  // The task is flagged for human review and the human hasn't approved it yet
  humanReviewOutstanding: boolean
  merge: {
    eligible: boolean
    // The first gate that failed, in the order core checks them
    failingGate: MergeGate | null
    failedGates: MergeGate[]
  }
}

export type CheckConclusion = 'success' | 'failure' | 'pending' | 'neutral' | 'skipped'

// ── Deployments ─────────────────────────────────────────────────────────────

const commitSha = z.string().regex(/^[0-9a-f]{40}$/)

// What scripts/deploy/auto-deploy.sh posts after `docker compose up -d`
// (D16). The project is the one whose repository is `repository`. Posting
// the same toSha again returns the existing deployment.
export const createDeploymentInput = z.object({
  repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/),
  // Null for the first deploy
  fromSha: commitSha.nullable(),
  toSha: commitSha,
  // Newest first, as `git log` lists them. Every commit in the range, however
  // many: a capped list would lose the oldest and the PM's notes with them.
  commits: z.array(z.object({ sha: commitSha, subject: z.string() }))
})
export type CreateDeploymentInput = z.infer<typeof createDeploymentInput>

export const DEPLOYMENT_NOTES_STATUSES = ['pending', 'ready', 'failed'] as const
export type DeploymentNotesStatus = typeof DEPLOYMENT_NOTES_STATUSES[number]

export interface Deployment {
  id: string
  projectId: string
  fromSha: string | null
  toSha: string
  commits: { sha: string, subject: string }[]
  // The PM's release notes in markdown, once notesStatus is ready
  notes: string | null
  notesStatus: DeploymentNotesStatus
  readAt: string | null
  createdAt: string
}
