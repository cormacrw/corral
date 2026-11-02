import type { EpicRebaseDecision, ResolutionReview } from '@corral/core'
import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, timestamp, unique, uniqueIndex, uuid } from 'drizzle-orm/pg-core'
import { createdAt, updatedAt } from './columns.ts'
import { epics } from './epics.ts'
import { tasks } from './tasks.ts'

// Immutable identity per submission. Revisions insert another row; reviewed and
// integrated commits belong to that submission, never to a mutable branch tip.
export const taskSubmissions = pgTable('task_submissions', {
  id: uuid().primaryKey().defaultRandom(),
  taskId: uuid().notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  sequence: integer().notNull(),
  protocol: integer().notNull().default(1),
  branch: text().notNull(),
  submittedHeadSha: text().notNull(),
  baseSha: text().notNull(),
  targetBranch: text().notNull(),
  agentApprovedHeadSha: text(),
  integratedCommitSha: text(),
  integratedAt: timestamp({ withTimezone: true }),
  createdAt: createdAt()
}, t => [
  unique().on(t.taskId, t.sequence),
  index().on(t.taskId),
  check('task_submissions_positive_version', sql`${t.sequence} > 0 and ${t.protocol} > 0`),
  check('task_submissions_approval_matches_head', sql`${t.agentApprovedHeadSha} is null or ${t.agentApprovedHeadSha} = ${t.submittedHeadSha}`),
  check('task_submissions_integration_complete', sql`(${t.integratedCommitSha} is null) = (${t.integratedAt} is null) and (${t.integratedCommitSha} is null or ${t.agentApprovedHeadSha} is not null)`)
])

// Write intent before mutating git. The UUID is the idempotency key; the
// expected target head is the compare-and-swap fence. Unknown results remain
// reconciling until the remote ref has been read, never blindly replayed. An
// epic has one active operation of either kind: that row is its writer lock.
export const taskIntegrationOperations = pgTable('task_integration_operations', {
  id: uuid().primaryKey().defaultRandom(),
  // Null for a rebase, which moves the whole epic rather than one submission
  submissionId: uuid().references(() => taskSubmissions.id, { onDelete: 'cascade' }),
  // The shared branch being advanced: one operation at a time per epic
  epicId: uuid().notNull().references(() => epics.id, { onDelete: 'cascade' }),
  kind: text({ enum: ['integrate', 'rebase'] }).notNull(),
  state: text({ enum: ['pending', 'running', 'reconciling', 'succeeded', 'failed'] }).notNull().default('pending'),
  expectedTargetSha: text().notNull(),
  resultHeadSha: text(),
  // The target branch commit a rebase moves the epic onto
  ontoSha: text(),
  // The task resolving a rebase's conflicts on its own candidate branch
  resolutionTaskId: uuid().references(() => tasks.id, { onDelete: 'set null' }),
  conflictFiles: jsonb().$type<string[]>(),
  // The reviewer's judgment of the resolution, bound to the commit it read
  resolutionReview: jsonb().$type<ResolutionReview>(),
  // Questions the resolution put to the human, oldest first, with their answers
  decisions: jsonb().$type<EpicRebaseDecision[]>().notNull().default([]),
  // Pushes of a reviewed resolution, which stays active between them
  pushAttempts: integer().notNull().default(0),
  runnerId: text(),
  leaseEpoch: integer().notNull(),
  error: text(),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, t => [
  index().on(t.submissionId),
  uniqueIndex('task_integration_one_active_operation').on(t.submissionId).where(sql`${t.state} in ('pending', 'running', 'reconciling')`),
  uniqueIndex('task_integration_one_active_per_epic').on(t.epicId).where(sql`${t.state} in ('pending', 'running', 'reconciling')`),
  check('task_integration_operation_kind', sql`${t.kind} in ('integrate', 'rebase')`),
  check('task_integration_operation_subject', sql`(${t.kind} = 'integrate') = (${t.submissionId} is not null) and (${t.kind} = 'rebase') = (${t.ontoSha} is not null)`),
  check('task_integration_operation_state', sql`${t.state} in ('pending', 'running', 'reconciling', 'succeeded', 'failed')`),
  check('task_integration_operation_epoch', sql`${t.leaseEpoch} >= 0`),
  check('task_integration_operation_result', sql`${t.state} <> 'succeeded' or ${t.resultHeadSha} is not null`)
])
