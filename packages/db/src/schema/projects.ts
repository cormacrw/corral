import { sql } from 'drizzle-orm'
import { boolean, check, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt, updatedAt } from './columns.ts'
import { epicReviewMode, mergeMethod } from './enums.ts'

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
  // The review mode of each new epic a plan doesn't give one (D23)
  epicReviewModeDefault: epicReviewMode().notNull().default('epic'),
  reviewRoundCap: integer().notNull().default(5),
  failedRunCap: integer().notNull().default(3),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, t => [
  check('projects_prefix_format', sql`${t.prefix} ~ '^[A-Z]{2,5}$'`),
  check('projects_caps_positive', sql`${t.reviewRoundCap} > 0 and ${t.failedRunCap} > 0`)
])
