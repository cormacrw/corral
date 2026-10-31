import { sql } from 'drizzle-orm'
import { check, foreignKey, index, integer, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'
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
}, t => [index().on(t.taskId, t.headSha), index().on(t.runId)])

// Proof for acceptance criteria (PRD §7.7). The file is an immutable blob;
// this row says what it proves. `round` is the task's review round when it
// was attached, so each revision needs its own evidence. A `note` is a
// written explanation with no file (D21): its text is the evidence.
export const evidence = pgTable('evidence', {
  id: uuid().primaryKey().defaultRandom(),
  // Null for a PM file shared in its Plan conversation, owned by runId.
  taskId: uuid().references(() => tasks.id, { onDelete: 'cascade' }),
  // Null for evidence about the task as a whole (e.g. a full test run)
  criterionId: uuid(),
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
  check('evidence_criterion_requires_task', sql`${t.criterionId} is null or ${t.taskId} is not null`),
  // Migration uses SET NULL (criterion_id) to preserve task_id.
  foreignKey({ name: 'evidence_criterion_same_task_fk', columns: [t.taskId, t.criterionId], foreignColumns: [acceptanceCriteria.taskId, acceptanceCriteria.id] }).onDelete('set null'),
  index().on(t.taskId, t.round),
  index().on(t.runId),
  index().on(t.criterionId),
  // ECMAScript trim whitespace, including NBSP and BOM, matches the API.
  check('evidence_note_or_file', sql`(
    (${t.kind}::text = 'note' and ${t.note} ~ '[^\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]' and ${t.blob} is null and ${t.fileName} is null and ${t.contentType} is null and ${t.size} = 0)
    or (${t.kind}::text <> 'note' and ${t.blob} is not null and ${t.blob} ~ '[^\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]' and ${t.fileName} is not null and ${t.fileName} ~ '[^\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]' and ${t.contentType} is not null and ${t.contentType} ~ '[^\\u0009-\\u000D\\u0020\\u00A0\\u1680\\u2000-\\u200A\\u2028\\u2029\\u202F\\u205F\\u3000\\uFEFF]' and ${t.size} >= 0)
  )`)
])
