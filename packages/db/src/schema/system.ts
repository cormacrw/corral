import { bigint, index, jsonb, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { actor, createdAt, updatedAt } from './columns.ts'
import { projects } from './projects.ts'
import { tasks } from './tasks.ts'

// Instance-wide switches, e.g. the kill switch (PRD §7.11 control panel)
export const settings = pgTable('settings', {
  key: text().primaryKey(),
  value: jsonb().notNull(),
  updatedAt: updatedAt()
})

// Append-only record of who did what (D1). Every status change writes one.
export const auditLog = pgTable('audit_log', {
  id: bigint({ mode: 'number' }).primaryKey().generatedAlwaysAsIdentity(),
  projectId: uuid().references(() => projects.id, { onDelete: 'cascade' }),
  // Kept when a Backlog task is deleted outright, so its history survives
  taskId: uuid().references(() => tasks.id, { onDelete: 'set null' }),
  actor: actor('actor'),
  // e.g. 'task.transition', 'task.created', 'project.updated'
  action: text().notNull(),
  detail: jsonb().notNull().default({}),
  createdAt: createdAt()
}, t => [index().on(t.taskId), index().on(t.projectId, t.createdAt)])
