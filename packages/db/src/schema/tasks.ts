import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  unique,
  uuid,
  type AnyPgColumn
} from 'drizzle-orm/pg-core'
import { actor, createdAt, updatedAt } from './columns.ts'
import { agentRole, taskKind, taskPriority, taskStatus, taskType } from './enums.ts'
import { epics } from './epics.ts'
import { projects } from './projects.ts'
// Import cycle with runs.ts: tasks.leaseRunId and runs.taskId point at each
// other. See schema.ts.
import { runs } from './runs.ts'

// A reviewed unit of work: legacy task PR or PR-free epic submission (D27).
// Status, counters and reason mirror core's TaskState; leases are the lock.
export const tasks = pgTable('tasks', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // Per-project number; the ref is `${project.prefix}-${number}` (D13)
  number: integer().notNull(),
  epicId: uuid(),
  title: text().notNull(),
  // Rich-text document from the editor (design/task.md)
  description: jsonb(),
  status: taskStatus().notNull().default('backlog'),
  priority: taskPriority().notNull().default('medium'),
  type: taskType().notNull(),
  kind: taskKind().notNull().default('normal'),
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
  // 0: existing PR/spike/design path. Positive: negotiated PR-free protocol.
  // Additive rollout: never infer this from a nullable PR number on old rows.
  integrationProtocol: integer().notNull().default(0),
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
  unique('tasks_project_id_unique').on(t.projectId, t.id),
  // Migration uses SET NULL (epic_id) to preserve the required project.
  foreignKey({ name: 'tasks_epic_same_project_fk', columns: [t.projectId, t.epicId], foreignColumns: [epics.projectId, epics.id] }).onDelete('set null'),
  index().on(t.projectId, t.status),
  // Match JavaScript trim's whitespace, including Unicode, on both drivers.
  check('tasks_status_reason', sql`case when ${t.status} in ('blocked', 'failed')
    then ${t.statusReason} is not null and btrim(${t.statusReason}, U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680\\2000\\2001\\2002\\2003\\2004\\2005\\2006\\2007\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF') <> ''
    else ${t.statusReason} is null end`),
  check('tasks_pr_complete', sql`(${t.prNumber} is null) = (${t.prUrl} is null)`),
  check('tasks_integration_protocol', sql`${t.integrationProtocol} >= 0 and (${t.integrationProtocol} = 0 or (${t.prNumber} is null and ${t.epicId} is not null and ${t.type}::text in ('task', 'bug')))`),
  check('tasks_counters_non_negative', sql`${t.reviewRounds} >= 0 and ${t.failedRuns} >= 0 and ${t.leaseEpoch} >= 0`),
  // A lease is either fully held or fully released
  check('tasks_lease_complete', sql`(${t.leaseRunId} is null) = (${t.leaseExpiresAt} is null)
    and (${t.leaseRunId} is null) = (${t.leaseRole} is null)`)
])

// Each criterion must be individually verifiable (PRD §4.3)
export const acceptanceCriteria = pgTable('acceptance_criteria', {
  checkedByHuman: boolean().notNull().default(false),
  id: uuid().primaryKey().defaultRandom(),
  taskId: uuid().notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  position: integer().notNull(),
  text: text().notNull(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, t => [index().on(t.taskId, t.position), unique('criteria_task_id_unique').on(t.taskId, t.id)])

// `taskId` depends on `dependsOnId`. Cycles are rejected by core before writing.
// Both ends are keyed through projectId, so an edge can't cross projects.
export const taskDependencies = pgTable('task_dependencies', {
  projectId: uuid().notNull(),
  taskId: uuid().notNull(),
  dependsOnId: uuid().notNull(),
  createdAt: createdAt()
}, t => [
  primaryKey({ columns: [t.taskId, t.dependsOnId] }),
  index().on(t.dependsOnId),
  foreignKey({ name: 'task_dependencies_task_same_project_fk', columns: [t.projectId, t.taskId], foreignColumns: [tasks.projectId, tasks.id] }).onDelete('cascade'),
  foreignKey({ name: 'task_dependencies_depends_on_same_project_fk', columns: [t.projectId, t.dependsOnId], foreignColumns: [tasks.projectId, tasks.id] }).onDelete('cascade'),
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
