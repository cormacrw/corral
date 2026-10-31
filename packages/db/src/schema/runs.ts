import { sql } from 'drizzle-orm'
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uuid,
  type AnyPgColumn
} from 'drizzle-orm/pg-core'
import { DESIGNER_RUN_OUTCOMES, DEVELOPER_RUN_OUTCOMES, PM_RUN_OUTCOMES, REVIEWER_RUN_OUTCOMES, TERMINAL_RUN_STATES } from '@corral/core'
import { createdAt, updatedAt } from './columns.ts'
import { agentRole, runOutcome, runState } from './enums.ts'
import { epics } from './epics.ts'
// Import cycle with plans.ts: runs.planSessionId and planMessages.runId go
// opposite ways. See schema.ts.
import { planSessions } from './plans.ts'
import { projects } from './projects.ts'
// Import cycle with tasks.ts: see the note there
import { tasks } from './tasks.ts'

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

const sqlList = (values: readonly string[]) => sql.raw(`(${values.map(v => `'${v}'`).join(', ')})`)
const terminalStates = sqlList(TERMINAL_RUN_STATES)

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
  // Phase and tool timings from the runner; null from older runners
  timings: jsonb(),
  queuedAt: timestamp({ withTimezone: true }).notNull().defaultNow(),
  startedAt: timestamp({ withTimezone: true }),
  endedAt: timestamp({ withTimezone: true })
}, t => [
  index().on(t.taskId),
  index().on(t.epicId),
  index().on(t.agentId, t.state),
  check('runs_task_unless_pm', sql`${t.taskId} is not null or ${t.role} = 'pm' or (${t.epicId} is not null and ${t.role} = 'reviewer')`),
  // A PM turn belongs to neither a task nor an epic, a developer or designer
  // never to an epic, and a reviewer to one or the other. planSessionId isn't checked: it
  // goes null when its session is deleted.
  // Roles as text too: designer is added in the same migration batch on a new database
  check('runs_role_context', sql`case ${t.role}::text
    when 'pm' then ${t.taskId} is null and ${t.epicId} is null
    when 'developer' then ${t.epicId} is null
    when 'designer' then ${t.epicId} is null
    else ${t.taskId} is null or ${t.epicId} is null
  end`),
  check('runs_ended_at_matches_state', sql`(${t.state} in ${terminalStates}) = (${t.endedAt} is not null)`),
  check('runs_outcome_only_when_ended', sql`${t.outcome} is null or ${t.state} in ${terminalStates}`),
  // As text: a migration can't use an enum value added in its own transaction
  check('runs_outcome_matches_role', sql`${t.outcome} is null or case ${t.role}::text
    when 'developer' then ${t.outcome}::text in ${sqlList(DEVELOPER_RUN_OUTCOMES)}
    when 'designer' then ${t.outcome}::text in ${sqlList(DESIGNER_RUN_OUTCOMES)}
    when 'reviewer' then ${t.outcome}::text in ${sqlList(REVIEWER_RUN_OUTCOMES)}
    else ${t.outcome}::text in ${sqlList(PM_RUN_OUTCOMES)}
  end`)
])
