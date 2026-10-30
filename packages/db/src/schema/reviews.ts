import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { actor, createdAt } from './columns.ts'
import { evidenceKind, reviewVerdict } from './enums.ts'
import { runs } from './runs.ts'
import { acceptanceCriteria, tasks } from './tasks.ts'

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
  criteria: jsonb().$type<{ criterionId: string, met: boolean | null, note: string }[]>().notNull().default([]),
  // Who gave the verdict: the reviewer agent, or a human in Human review
  author: actor('author'),
  createdAt: createdAt()
}, t => [index().on(t.taskId, t.headSha)])

// Proof for acceptance criteria (PRD §7.7). The file is an immutable blob;
// this row says what it proves. `round` is the task's review round when it
// was attached, so each revision needs its own evidence. A `note` is a
// written explanation with no file (D21): its text is the evidence.
export const evidence = pgTable('evidence', {
  id: uuid().primaryKey().defaultRandom(),
  // Null for a PM file shared in its Plan conversation, owned by runId.
  taskId: uuid().references(() => tasks.id, { onDelete: 'cascade' }),
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
