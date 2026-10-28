import {
  AGENT_ROLES,
  MERGE_METHODS,
  RUN_OUTCOMES,
  RUN_STATES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES,
  type Actor
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

const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
// Who did it (D1). Stored whole, so agents and system components need no table of their own.
const actor = (name: string) => jsonb(name).$type<Actor>().notNull()

// People. The POC has one, but nothing assumes that (D1).
export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
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
  createdBy: actor('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, t => [index().on(t.projectId)])

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
  reviewRounds: integer().notNull().default(0),
  failedRuns: integer().notNull().default(0),
  // Why the task is Blocked or Failed (D10, D11)
  statusReason: text(),
  // Set when the human stops a run, so the scheduler doesn't restart it (flows.md §3)
  paused: boolean().notNull().default(false),
  branch: text(),
  prNumber: integer(),
  prUrl: text(),

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
  // Set when a usage limit is hit; the group resumes after it (D3)
  pausedUntil: timestamp({ withTimezone: true }),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, t => [check('agents_concurrency_positive', sql`${t.concurrency} > 0`)])

// One agent session (PRD §4.5). PM turns have no task.
export const runs = pgTable('runs', {
  id: uuid().primaryKey().defaultRandom(),
  // Shown as #128 in the UI (D13)
  number: bigint({ mode: 'number' }).notNull().generatedAlwaysAsIdentity().unique(),
  agentId: uuid().notNull().references(() => agents.id),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  taskId: uuid().references(() => tasks.id, { onDelete: 'cascade' }),
  role: agentRole().notNull(),
  state: runState().notNull().default('queued'),
  outcome: runOutcome(),
  // The lease epoch this run was given; writes carrying another epoch are stale
  leaseEpoch: integer(),
  summary: text(),
  error: text(),
  // Known reset time when the outcome is rate_limited (D3)
  rateLimitResetAt: timestamp({ withTimezone: true }),
  // sha256 of the JSONL transcript in the blob store; transcripts never go in the database (D8)
  transcriptBlob: text(),
  inputTokens: integer(),
  outputTokens: integer(),
  queuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp({ withTimezone: true }),
  endedAt: timestamp({ withTimezone: true })
}, t => [
  index().on(t.taskId),
  index().on(t.agentId, t.state),
  check('runs_task_unless_pm', sql`${t.taskId} is not null or ${t.role} = 'pm'`)
])

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
