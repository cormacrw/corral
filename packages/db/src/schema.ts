import {
  AGENT_ROLES,
  DESIGN_VERSION_STATUSES,
  EPIC_REVIEW_MODES,
  EPIC_REVIEW_STATES,
  MERGE_METHODS,
  RUN_OUTCOMES,
  RUN_STATES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type Actor,
  type PmAction,
  type TaskType
} from '@corral/core'
import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn
} from 'drizzle-orm/pg-core'

// Postgres dialect only, and only features PGlite also supports, so the
// same migrations run on both (D14)

export const taskStatus = pgEnum('task_status', TASK_STATUSES)
export const taskPriority = pgEnum('task_priority', TASK_PRIORITIES)
export const taskType = pgEnum('task_type', TASK_TYPES)
export const agentRole = pgEnum('agent_role', AGENT_ROLES)
export const runState = pgEnum('run_state', RUN_STATES)
export const runOutcome = pgEnum('run_outcome', RUN_OUTCOMES)
export const mergeMethod = pgEnum('merge_method', MERGE_METHODS)
export const epicReviewMode = pgEnum('epic_review_mode', EPIC_REVIEW_MODES)
export const epicReviewState = pgEnum('epic_review_state', EPIC_REVIEW_STATES)

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
// Who did it (D1). Stored whole, so agents and system components need no table of their own.
const actor = (name: string) => jsonb(name).$type<Actor>().notNull()

// People. The POC has one, but nothing assumes that (D1).
export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  // Profile picture: a blob hash and its image type, or none
  avatarBlob: text(),
  avatarContentType: text(),
  createdAt: createdAt()
})

// One project per Git repository (PRD §4.1, D13)
export const projects = pgTable('projects', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  slug: text().notNull().unique(),
  // Task IDs are PREFIX-NUMBER; prefixes are unique across projects (D13)
  prefix: text().notNull().unique(),
  nextTaskNumber: integer().notNull().default(1),
  thumbnailColor: text(),
  // sha256 of an uploaded image in the blob store; replaces the colour
  thumbnailBlob: text(),
  // GitHub `owner/name`. Unique: the repository ownership lock (PRD §7.1, D13)
  repository: text().notNull().unique(),
  defaultBranch: text().notNull(),
  mergeMethod: mergeMethod().notNull().default('squash'),
  requiredChecks: text().array().notNull().default(sql`'{}'::text[]`),
  paused: boolean().notNull().default(false),
  // Default for each new task's human-review flag (D5)
  humanReviewDefault: boolean().notNull().default(false),
  // The review mode of each new epic a plan doesn't give one (D23)
  epicReviewModeDefault: epicReviewMode().notNull().default('epic'),
  reviewRoundCap: integer().notNull().default(5),
  failedRunCap: integer().notNull().default(3),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, t => [
  check('projects_prefix_format', sql`${t.prefix} ~ '^[A-Z]{2,5}$'`),
  check('projects_caps_positive', sql`${t.reviewRoundCap} > 0 and ${t.failedRunCap} > 0`)
])

export const epics = pgTable('epics', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  description: text().notNull().default(''),
  priority: taskPriority().notNull().default('medium'),
  // Set from the plan or the project's default when the epic is created (D23).
  // Epics that had board tasks before review modes existed are `direct`.
  reviewMode: epicReviewMode().notNull().default('epic'),
  // The epic branch and its PR into the target branch, in `epic` and
  // `each_task` modes; null until Corral creates them (D23)
  branch: text(),
  prNumber: integer(),
  prHeadSha: text(),
  reviewState: epicReviewState(),
  createdBy: actor('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, t => [index().on(t.projectId)])

// Epic prerequisites gate developer claims; core validates the combined graph.
export const epicDependencies = pgTable('epic_dependencies', {
  epicId: uuid().notNull().references(() => epics.id, { onDelete: 'cascade' }),
  dependsOnEpicId: uuid().notNull().references(() => epics.id, { onDelete: 'cascade' })
}, t => [
  primaryKey({ columns: [t.epicId, t.dependsOnEpicId] }),
  index().on(t.dependsOnEpicId),
  check('epic_dependencies_not_self', sql`${t.epicId} <> ${t.dependsOnEpicId}`)
])

// The unit of work that becomes one PR (PRD §4.3). Status, counters and
// reason mirror core's TaskState; the lease columns are the lock (PRD §4.6).
export const tasks = pgTable('tasks', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // Per-project number; the ref is `${project.prefix}-${number}` (D13)
  number: integer().notNull(),
  epicId: uuid().references(() => epics.id, { onDelete: 'set null' }),
  title: text().notNull(),
  // Rich-text document from the editor (design/task.md)
  description: jsonb(),
  status: taskStatus().notNull().default('backlog'),
  priority: taskPriority().notNull().default('medium'),
  type: taskType().notNull(),
  humanReview: boolean().notNull().default(false),
  rebaseOnly: boolean().notNull().default(false),
  approvedHeadSha: text(),
  reviewRounds: integer().notNull().default(0),
  failedRuns: integer().notNull().default(0),
  // Why the task is Blocked or Failed (D10, D11)
  statusReason: text(),
  // Set when the human stops a run, so the scheduler doesn't restart it (flows.md §3)
  paused: boolean().notNull().default(false),
  branch: text(),
  prNumber: integer(),
  prUrl: text(),
  // The commit the developer last submitted; reviews and approvals are tied to it
  headSha: text(),
  // Set after asking GitHub to merge the base branch in, so the next head
  // keeps its approval (R7: a clean mechanical update keeps approval)
  branchUpdateRequested: boolean().notNull().default(false),
  // Required checks seen passing when the task reached Human review (design/inbox.md)
  gateChecks: jsonb().$type<{ name: string, url: string | null }[]>(),
  // Recorded when GitHub confirmed the merge (PRD §7.9)
  mergeCommitSha: text(),
  mergedAt: timestamp({ withTimezone: true }),

  // Fencing token: goes up by one on every claim and never goes down, so a
  // stale runner's writes can be rejected (stale-runners-and-fencing.md)
  leaseEpoch: integer().notNull().default(0),
  leaseRunId: uuid().references((): AnyPgColumn => runs.id, { onDelete: 'set null' }),
  leaseRole: agentRole(),
  leaseAcquiredAt: timestamp({ withTimezone: true }),
  leaseHeartbeatAt: timestamp({ withTimezone: true }),
  leaseExpiresAt: timestamp({ withTimezone: true }),

  createdBy: actor('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt(),
  // Soft delete (D10); Backlog tasks are deleted outright instead
  deletedAt: timestamp({ withTimezone: true })
}, t => [
  unique('tasks_project_number_unique').on(t.projectId, t.number),
  index().on(t.projectId, t.status),
  check('tasks_counters_non_negative', sql`${t.reviewRounds} >= 0 and ${t.failedRuns} >= 0 and ${t.leaseEpoch} >= 0`),
  // A lease is either fully held or fully released
  check('tasks_lease_complete', sql`(${t.leaseRunId} is null) = (${t.leaseExpiresAt} is null)
    and (${t.leaseRunId} is null) = (${t.leaseRole} is null)`)
])

// Each criterion must be individually verifiable (PRD §4.3)
export const acceptanceCriteria = pgTable('acceptance_criteria', {
  id: uuid().primaryKey().defaultRandom(),
  taskId: uuid().notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  position: integer().notNull(),
  text: text().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, t => [index().on(t.taskId, t.position)])

// `taskId` depends on `dependsOnId`. Cycles are rejected by core before writing.
export const taskDependencies = pgTable('task_dependencies', {
  taskId: uuid().notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  dependsOnId: uuid().notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  createdAt: createdAt()
}, t => [
  primaryKey({ columns: [t.taskId, t.dependsOnId] }),
  index().on(t.dependsOnId),
  check('task_dependencies_not_self', sql`${t.taskId} <> ${t.dependsOnId}`)
])

export const comments = pgTable('comments', {
  id: uuid().primaryKey().defaultRandom(),
  taskId: uuid().notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  author: actor('author'),
  body: text().notNull(),
  // Agents read pinned comments before implementing or revising (PRD §4.7)
  pinned: boolean().notNull().default(false),
  createdAt: createdAt()
}, t => [index().on(t.taskId)])

// Global agents serving every project (D13), e.g. Juno, Atlas, Vera
export const agents = pgTable('agents', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull().unique(),
  role: agentRole().notNull(),
  runtime: text().notNull().default('claude-code'),
  // Applies across all projects (D13)
  concurrency: integer().notNull().default(1),
  paused: boolean().notNull().default(false),
  // The periodic tick starts work for this agent at most this often; events
  // such as plan approval still start it right away. Null means every tick.
  wakeIntervalSeconds: integer(),
  // Set when a usage limit is hit; the group resumes after it (D3)
  pausedUntil: timestamp({ withTimezone: true }),
  // Profile picture: a blob hash and its image type, or none
  avatarBlob: text(),
  avatarContentType: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, t => [
  check('agents_concurrency_positive', sql`${t.concurrency} > 0`),
  check('agents_wake_interval_positive', sql`${t.wakeIntervalSeconds} > 0`)
])

// One agent session (PRD §4.5). PM turns have no task.
export const runs = pgTable('runs', {
  runnerId: text(),
  // The runner's name when the run was placed on it, shown on the run
  runnerName: text(),
  id: uuid().primaryKey().defaultRandom(),
  // Shown as #128 in the UI (D13)
  number: bigint({ mode: 'number' }).notNull().generatedAlwaysAsIdentity().unique(),
  agentId: uuid().notNull().references(() => agents.id),
  projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
  taskId: uuid().references(() => tasks.id, { onDelete: 'cascade' }),
  // Integration reviews belong to an epic, independently of task reviews.
  epicId: uuid().references(() => epics.id, { onDelete: 'cascade' }),
  leaseExpiresAt: timestamp({ withTimezone: true }),
  role: agentRole().notNull(),
  state: runState().notNull().default('queued'),
  outcome: runOutcome(),
  // The lease epoch this run was given; writes carrying another epoch are stale
  leaseEpoch: integer(),
  // The agent CLI's own session, so PM turns can resume it (D9)
  agentSessionId: text(),
  // PM turns belong to a plan session instead of a task
  planSessionId: uuid().references((): AnyPgColumn => planSessions.id, { onDelete: 'set null' }),
  // A PM turn waiting for one of Juno's slots keeps its job here until it's
  // sent to the runner (D13), so it survives a restart
  pmJob: jsonb(),
  // The commit a developer run pushed, or a reviewer run reviewed
  headSha: text(),
  summary: text(),
  error: text(),
  // Known reset time when the outcome is rate_limited (D3)
  rateLimitResetAt: timestamp({ withTimezone: true }),
  // sha256 of the JSONL transcript in the blob store; transcripts never go in the database (D8)
  transcriptBlob: text(),
  inputTokens: integer(),
  cacheReadTokens: integer(),
  outputTokens: integer(),
  queuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp({ withTimezone: true }),
  endedAt: timestamp({ withTimezone: true })
}, t => [
  index().on(t.taskId),
  index().on(t.epicId),
  index().on(t.agentId, t.state),
  check('runs_task_unless_pm', sql`${t.taskId} is not null or ${t.role} = 'pm' or (${t.epicId} is not null and ${t.role} = 'reviewer')`)
])

export const planStatus = pgEnum('plan_status', ['proposed', 'approved', 'superseded', 'discarded'])
export const planChange = pgEnum('plan_change', ['added', 'changed', 'unchanged', 'removed'])

// A conversation with the PM (D9, design/plan.md). Belongs to one project.
// The agent CLI's session ID is only a cache: the messages here are the
// source of truth, and a lost session is reseeded from them.
export const planSessions = pgTable('plan_sessions', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  agentSessionId: text(),
  // The PM's runtime for this session (D18), picked in the composer and
  // locked once it has messages: an agent session ID only resumes on the
  // vendor that made it
  runtime: text().notNull().default('claude-code'),
  // Set when a PM turn finishes (and for the epic delivery summary, D11);
  // cleared when the human opens the session or sends a message
  unread: boolean().notNull().default(false),
  // Set when its plan is approved; a new human message reopens it
  closedAt: timestamp({ withTimezone: true }),
  createdBy: actor('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, t => [index().on(t.projectId, t.updatedAt)])

export const planMessages = pgTable('plan_messages', {
  id: uuid().primaryKey().defaultRandom(),
  sessionId: uuid().notNull().references(() => planSessions.id, { onDelete: 'cascade' }),
  // 'human' or 'pm'; questions are PM messages flagged as such
  role: text().notNull(),
  kind: text().notNull().default('message'),
  text: text().notNull(),
  // Confirm-required PM calls are durable action records as well as cards.
  pendingAction: jsonb().$type<PmAction>(),
  // A question's suggested answer and answer choices (ask_question)
  recommendation: text(),
  options: jsonb().$type<string[]>(),
  planId: uuid().references((): AnyPgColumn => plans.id, { onDelete: 'set null' }),
  runId: uuid().references(() => runs.id, { onDelete: 'set null' }),
  createdAt: createdAt()
}, t => [index().on(t.sessionId, t.createdAt)])

// A versioned plan from propose_plan; its tasks live in Backlog until a
// human approves the plan (D9, D10)
export const plans = pgTable('plans', {
  id: uuid().primaryKey().defaultRandom(),
  sessionId: uuid().notNull().references(() => planSessions.id, { onDelete: 'cascade' }),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  epicId: uuid().references(() => epics.id, { onDelete: 'set null' }),
  version: integer().notNull(),
  title: text().notNull(),
  summary: text().notNull().default(''),
  status: planStatus().notNull().default('proposed'),
  approvedBy: jsonb('approved_by').$type<Actor>(),
  approvedAt: timestamp({ withTimezone: true }),
  createdAt: createdAt()
}, t => [unique('plans_session_version_unique').on(t.sessionId, t.version)])

export const planTasks = pgTable('plan_tasks', {
  planId: uuid().notNull().references(() => plans.id, { onDelete: 'cascade' }),
  // Null once a removed task has been deleted
  taskId: uuid().references(() => tasks.id, { onDelete: 'set null' }),
  // The PM's handle inside the plan
  key: text().notNull(),
  change: planChange().notNull(),
  position: integer().notNull(),
  // Set when the item revises an existing Backlog task (or a Draft from
  // elsewhere): the proposed edits, written to the task only on approval
  revision: jsonb().$type<PlanRevision>()
}, t => [primaryKey({ columns: [t.planId, t.key] })])

export interface PlanRevision {
  title: string
  // Markdown, as the PM wrote it
  description: string
  type: TaskType
  priority: 'urgent' | 'high' | 'medium' | 'low'
  humanReview: boolean
  acceptanceCriteria: string[]
  // Null when the revised task has no epic
  epicId: string | null
  // Task numbers in the same project
  dependsOn: number[]
  // The design version the task is pinned to, and its screens (D20). Absent
  // on revisions saved before pins existed.
  design?: { designVersionId: string, screens: string[] } | null
}

// The epics of a plan version, by the PM's key, so a revision keeps each
// epic it still names (a plan can span several; plans.epicId is the first)
export const planEpics = pgTable('plan_epics', {
  dependsOn: jsonb().$type<string[]>().notNull().default([]),
  planId: uuid().notNull().references(() => plans.id, { onDelete: 'cascade' }),
  // Null once the epic has been deleted
  epicId: uuid().references(() => epics.id, { onDelete: 'set null' }),
  key: text().notNull(),
  position: integer().notNull()
}, t => [primaryKey({ columns: [t.planId, t.key] })])

// Instance-wide switches, e.g. the kill switch (PRD §7.11 control panel)
export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: updatedAt()
})

// Append-only record of who did what (D1). Every status change writes one.
export const auditLog = pgTable('audit_log', {
  id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
  // Kept when a Backlog task is deleted outright, so its history survives
  taskId: uuid().references(() => tasks.id, { onDelete: 'set null' }),
  actor: actor('actor'),
  // e.g. 'task.transition', 'task.created', 'project.updated'
  action: text().notNull(),
  detail: jsonb().notNull().default({}),
  createdAt: createdAt()
}, t => [index().on(t.taskId), index().on(t.projectId, t.createdAt)])

export const reviewVerdict = pgEnum('review_verdict', ['approved', 'changes_requested'])

// One reviewer verdict per round and commit (flows.md step 6). The per
// criterion verdicts are what the UI shows as "met" (design/task.md).
export const reviews = pgTable('reviews', {
  id: uuid().primaryKey().defaultRandom(),
  taskId: uuid().notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  runId: uuid().notNull().references(() => runs.id, { onDelete: 'cascade' }),
  // The task's review round when the verdict was given
  round: integer().notNull(),
  // The commit reviewed; an approval only counts for this commit (merge gate)
  headSha: text().notNull(),
  verdict: reviewVerdict().notNull(),
  summary: text().notNull(),
  criteria: jsonb().$type<{ criterionId: string, met: boolean, note: string }[]>().notNull().default([]),
  // Who gave the verdict: the reviewer agent, or a human in Human review
  author: actor('author'),
  createdAt: createdAt()
}, t => [index().on(t.taskId, t.headSha)])

export const evidenceKind = pgEnum('evidence_kind', ['screenshot', 'video', 'test_output', 'log', 'request', 'text', 'other', 'note'])

// Proof for acceptance criteria (PRD §7.7). The file is an immutable blob;
// this row says what it proves. `round` is the task's review round when it
// was attached, so each revision needs its own evidence. A `note` is a
// written explanation with no file (D21): its text is the evidence.
export const evidence = pgTable('evidence', {
  id: uuid().primaryKey().defaultRandom(),
  taskId: uuid().notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  // Null for evidence about the task as a whole (e.g. a full test run)
  criterionId: uuid().references(() => acceptanceCriteria.id, { onDelete: 'set null' }),
  runId: uuid().notNull().references(() => runs.id, { onDelete: 'cascade' }),
  round: integer().notNull(),
  kind: evidenceKind().notNull(),
  note: text().notNull().default(''),
  // sha256 in the blob store (D8); the file columns are null only for a note
  blob: text(),
  fileName: text(),
  contentType: text(),
  size: integer().notNull(),
  createdAt: createdAt()
}, t => [
  index().on(t.taskId, t.round),
  check('evidence_file_unless_note', sql`${t.kind}::text = 'note' or (${t.blob} is not null and ${t.fileName} is not null and ${t.contentType} is not null)`)
])

// Images pasted into task descriptions and comments. The bytes are an
// immutable blob (D8), so the same picture twice is stored once; each
// upload still gets its own row, which text references as attachment:<id>.
export const attachments = pgTable('attachments', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // sha256 in the blob store
  blob: text().notNull(),
  mimeType: text().notNull(),
  fileName: text().notNull(),
  byteSize: integer().notNull(),
  createdBy: actor('created_by'),
  createdAt: createdAt()
}, t => [index().on(t.projectId)])

export const designVersionStatus = pgEnum('design_version_status', DESIGN_VERSION_STATUSES)

// One submission to a design task (D20), numbered 1..n per task. The bundle,
// spec and screenshots are immutable blobs (D8), so a version outlives
// force-pushes and branch deletion; only its status and feedback change.
export const designVersions = pgTable('design_versions', {
  id: uuid().primaryKey().defaultRandom(),
  taskId: uuid().notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  version: integer().notNull(),
  status: designVersionStatus().notNull().default('submitted'),
  // sha256s in the blob store: the static bundle as one archive, and design.md
  bundleBlob: text().notNull(),
  specBlob: text().notNull(),
  // One or more per screen, in the order the developer gave them
  screenshots: jsonb().$type<{ blob: string, fileName: string, contentType: string }[]>().notNull().default([]),
  // The design/<ref> branch and the commit the version was built from
  branch: text().notNull(),
  commitSha: text().notNull(),
  // The human's feedback when they requested changes
  feedback: text(),
  // The Plan session approving this version opened for its build; at most one
  planSessionId: uuid().references(() => planSessions.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, t => [
  unique('design_versions_task_version_unique').on(t.taskId, t.version),
  check('design_versions_version_positive', sql`${t.version} > 0`)
])

// A build task's pin to the approved design version it builds and the
// screens (ids from design.md) it covers (D20). One per task.
export const taskDesignPins = pgTable('task_design_pins', {
  taskId: uuid().primaryKey().references(() => tasks.id, { onDelete: 'cascade' }),
  designVersionId: uuid().notNull().references(() => designVersions.id, { onDelete: 'cascade' }),
  screens: jsonb().$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, t => [index().on(t.designVersionId)])

export const deploymentNotesStatus = pgEnum('deployment_notes_status', ['pending', 'ready', 'failed'])

// What a deploy of a project shipped, reported by scripts/deploy/auto-deploy.sh
// after `docker compose up -d` (D16). One per deployed commit: posting the
// same toSha again returns the existing row. The PM writes the release notes
// later; they're an Inbox item until dismissed (D11). Reading only clears unread.
export const deployments = pgTable('deployments', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // Null for a project's first deploy
  fromSha: text(),
  toSha: text().notNull(),
  // Newest first, as `git log` lists them
  commits: jsonb().$type<{ sha: string, subject: string }[]>().notNull().default([]),
  // Markdown release notes
  notes: text(),
  notesStatus: deploymentNotesStatus().notNull().default('pending'),
  readAt: timestamp('read_at', { withTimezone: true }),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  createdAt: createdAt()
}, t => [unique('deployments_project_to_sha_unique').on(t.projectId, t.toSha)])
