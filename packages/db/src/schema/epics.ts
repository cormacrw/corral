import { sql } from 'drizzle-orm'
import { check, index, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core'
import { actor, createdAt, updatedAt } from './columns.ts'
import { epicReviewMode, epicReviewState, taskPriority } from './enums.ts'
import { projects } from './projects.ts'

export const epics = pgTable('epics', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  description: text().notNull().default(''),
  priority: taskPriority().notNull().default('medium'),
  // Set from the plan or the project's default when the epic is created (D23).
  // Epics that had board tasks before review modes existed are `direct`.
  reviewMode: epicReviewMode().notNull().default('epic'),
  // The epic branch and its PR into the target branch, in `epic` and
  // `each_task` modes; null until Corral creates them (D23)
  branch: text(),
  prNumber: integer(),
  prHeadSha: text(),
  reviewState: epicReviewState(),
  createdBy: actor('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, t => [index().on(t.projectId)])

// Epic prerequisites gate developer claims; core validates the combined graph.
export const epicDependencies = pgTable('epic_dependencies', {
  epicId: uuid().notNull().references(() => epics.id, { onDelete: 'cascade' }),
  dependsOnEpicId: uuid().notNull().references(() => epics.id, { onDelete: 'cascade' })
}, t => [
  primaryKey({ columns: [t.epicId, t.dependsOnEpicId] }),
  index().on(t.dependsOnEpicId),
  check('epic_dependencies_not_self', sql`${t.epicId} <> ${t.dependsOnEpicId}`)
])
