import { sql } from 'drizzle-orm'
import { check, integer, jsonb, pgTable, primaryKey, text, timestamp, uuid } from 'drizzle-orm/pg-core'
import { updatedAt } from './columns.ts'
import { projects } from './projects.ts'

// A step of a PR's guided review (COR-525): `hunk` is the position of the `@@`
// block in that file's patch
export interface PullRequestGuideStepRow {
  id: string
  title: string
  why: string
  criterionIds: string[]
  hunks: { path: string, hunk: number }[]
}

// One guide per project PR, for the head commit it was made for. A new push
// leaves it in place; the reader asks for a new one.
export const pullRequestGuides = pgTable('pull_request_guides', {
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  prNumber: integer().notNull(),
  status: text().notNull(),
  headSha: text(),
  steps: jsonb().$type<PullRequestGuideStepRow[]>().notNull().default([]),
  error: text(),
  generatedAt: timestamp({ withTimezone: true }),
  updatedAt: updatedAt()
}, t => [
  primaryKey({ columns: [t.projectId, t.prNumber] }),
  check('pull_request_guides_status', sql`${t.status} in ('generating', 'ready', 'failed')`)
])
