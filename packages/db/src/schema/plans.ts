import type { Actor, PlanTaskContent } from '@corral/core'
import {
  boolean,
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
import { planChange, planStatus } from './enums.ts'
import { epics } from './epics.ts'
import { projects } from './projects.ts'
// Import cycle with runs.ts: see the note there
import { runs } from './runs.ts'
import { tasks } from './tasks.ts'

// A conversation with the PM (D9, design/plan.md). Belongs to one project.
// The agent CLI's session ID is only a cache: the messages here are the
// source of truth, and a lost session is reseeded from them.
export const planSessions = pgTable('plan_sessions', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
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
  // Questions are PM messages flagged as such
  role: text().$type<'human' | 'pm'>().notNull(),
  kind: text().$type<'message' | 'question' | 'error'>().notNull().default('message'),
  text: text().notNull(),
  // A question's suggested answer and answer choices (ask_question)
  recommendation: text(),
  options: jsonb().$type<string[]>(),
  planId: uuid().references((): AnyPgColumn => plans.id, { onDelete: 'set null' }),
  runId: uuid().references(() => runs.id, { onDelete: 'set null' }),
  createdAt: createdAt()
}, t => [
  index().on(t.sessionId, t.createdAt),
  // Only new and updated rows are checked: the migration adds these NOT VALID,
  // so history stays as written and toMessage reads it
  check('plan_messages_role_kind', sql`(${t.role} = 'human' and ${t.kind} = 'message') or (${t.role} = 'pm' and ${t.kind} in ('message', 'question', 'error'))`),
  check('plan_messages_question_fields', sql`${t.kind} = 'question' or (${t.recommendation} is null and ${t.options} is null)`)
])

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
  // Set when the item revises an existing Backlog or unclaimed Ready task (or a Draft from
  // elsewhere): the proposed edits, written to the task only on approval
  revision: jsonb().$type<PlanRevision>()
}, t => [primaryKey({ columns: [t.planId, t.key] })])

export interface PlanRevision extends PlanTaskContent {
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
