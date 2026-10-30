import { sql } from 'drizzle-orm'
import {
  boolean,
  check,
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
import { agentRole, taskPriority, taskStatus, taskType } from './enums.ts'
import { epics } from './epics.ts'
import { projects } from './projects.ts'
// Import cycle with runs.ts: tasks.leaseRunId and runs.taskId point at each
// other. See schema.ts.
import { runs } from './runs.ts'

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
