import { sql } from 'drizzle-orm'
import { check, index, integer, jsonb, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core'
import { createdAt, updatedAt } from './columns.ts'
import { designVersionStatus } from './enums.ts'
import { planSessions } from './plans.ts'
import { tasks } from './tasks.ts'

// One submission to a design task (D20), numbered 1..n per task. The bundle,
// spec and screenshots are immutable blobs (D8), so a version outlives
// force-pushes and branch deletion; only its status and feedback change.
export const designVersions = pgTable('design_versions', {
  id: uuid().primaryKey().defaultRandom(),
  taskId: uuid().notNull().references(() => tasks.id, { onDelete: 'cascade' }),
  version: integer().notNull(),
  status: designVersionStatus().notNull().default('submitted'),
  // sha256s in the blob store: the static bundle as one archive, and design.md
  bundleBlob: text().notNull(),
  specBlob: text().notNull(),
  // One or more per screen, in the order the developer gave them
  screenshots: jsonb().$type<{ blob: string, fileName: string, contentType: string }[]>().notNull().default([]),
  // The design/<ref> branch and the commit the version was built from
  branch: text().notNull(),
  commitSha: text().notNull(),
  // The human's feedback when they requested changes
  feedback: text(),
  // The Plan session approving this version opened for its build; at most one
  planSessionId: uuid().references(() => planSessions.id, { onDelete: 'set null' }),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, t => [
  unique('design_versions_task_version_unique').on(t.taskId, t.version),
  check('design_versions_version_positive', sql`${t.version} > 0`)
])

// A build task's pin to the approved design version it builds and the
// screens (ids from design.md) it covers (D20). One per task.
export const taskDesignPins = pgTable('task_design_pins', {
  taskId: uuid().primaryKey().references(() => tasks.id, { onDelete: 'cascade' }),
  designVersionId: uuid().notNull().references(() => designVersions.id, { onDelete: 'cascade' }),
  screens: jsonb().$type<string[]>().notNull().default([]),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, t => [index().on(t.designVersionId)])
