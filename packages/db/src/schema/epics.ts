import { sql } from 'drizzle-orm'
import { boolean, check, foreignKey, index, integer, jsonb, pgTable, primaryKey, text, unique, uuid } from 'drizzle-orm/pg-core'
import { actor, createdAt, updatedAt } from './columns.ts'
import { epicReviewMode, epicReviewState, taskPriority } from './enums.ts'
import { projects } from './projects.ts'

export const epics = pgTable('epics', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  title: text().notNull(),
  description: text().notNull().default(''),
  priority: taskPriority().notNull().default('medium'),
  // Set from the plan or the project's default when the epic is created (D27).
  // Epics that had board tasks before review modes existed are `direct`.
  reviewMode: epicReviewMode().notNull().default('epic'),
  // The epic branch and its PR into the target branch, in `epic` and
  // `each_task` modes; null until Corral creates them (D27)
  branch: text(),
  prNumber: integer(),
  prHeadSha: text(),
  reviewState: epicReviewState(),
  // Set after asking GitHub to rebase the epic PR, so the next head keeps the
  // human's approval (D27: a clean rebase is a mechanical update)
  rebaseRequested: boolean().notNull().default(false),
  // The files a failed rebase conflicts on, while reviewState is `conflict`
  conflictFiles: jsonb().$type<string[]>(),
  // Recorded when GitHub confirmed the epic PR merged
  mergeCommitSha: text(),
  createdBy: actor('created_by'),
  createdAt: createdAt(),
  updatedAt: updatedAt()
}, t => [
  index().on(t.projectId),
  // The target of the composite keys that keep tasks and edges in one project
  unique('epics_project_id_unique').on(t.projectId, t.id)
])

// Epic prerequisites gate developer claims; core validates the combined graph.
// Both ends are keyed through projectId, so an edge can't cross projects.
export const epicDependencies = pgTable('epic_dependencies', {
  projectId: uuid().notNull(),
  epicId: uuid().notNull(),
  dependsOnEpicId: uuid().notNull()
}, t => [
  primaryKey({ columns: [t.epicId, t.dependsOnEpicId] }),
  index().on(t.dependsOnEpicId),
  foreignKey({ name: 'epic_dependencies_epic_same_project_fk', columns: [t.projectId, t.epicId], foreignColumns: [epics.projectId, epics.id] }).onDelete('cascade'),
  foreignKey({ name: 'epic_dependencies_depends_on_same_project_fk', columns: [t.projectId, t.dependsOnEpicId], foreignColumns: [epics.projectId, epics.id] }).onDelete('cascade'),
  check('epic_dependencies_not_self', sql`${t.epicId} <> ${t.dependsOnEpicId}`)
])
