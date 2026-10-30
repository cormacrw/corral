import { EVIDENCE_KINDS, REVIEW_VERDICTS, richTextIssue, TASK_PRIORITIES, TASK_TYPES, type Actor, type AgentRole, type EvidenceKind, type ReviewVerdict, type TaskPriority, type TaskStatus, type TaskType } from '@corral/core'
import { z } from 'zod'

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

export const reviewVerdict = z.enum(REVIEW_VERDICTS)

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

export const evidenceKind = z.enum(EVIDENCE_KINDS)
