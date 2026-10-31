import { doublePrecision, index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt } from './columns.ts'

// Shared timing samples; names are patterns, never URLs or request data.
export const perfSamples = pgTable('perf_samples', {
  metric: text(),
  sessionId: uuid('session_id'),
  id: uuid().primaryKey().defaultRandom(),
  kind: text().notNull(),
  name: text().notNull(),
  durationMs: doublePrecision('duration_ms').notNull(),
  status: integer(),
  queryCount: integer('query_count'),
  dbTimeMs: doublePrecision('db_time_ms'),
  createdAt: createdAt()
}, table => [index('perf_samples_kind_created_at_idx').on(table.kind, table.createdAt)])
