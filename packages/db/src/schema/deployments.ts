import { jsonb, pgTable, text, timestamp, unique, uuid } from 'drizzle-orm/pg-core'
import { createdAt } from './columns.ts'
import { deploymentNotesStatus } from './enums.ts'
import { projects } from './projects.ts'

// What a deploy of a project shipped, reported by scripts/deploy/auto-deploy.sh
// after `docker compose up -d` (D16). One per deployed commit: posting the
// same toSha again returns the existing row. The PM writes the release notes
// later; they're an Inbox item until dismissed (D11). Reading only clears unread.
export const deployments = pgTable('deployments', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // Null for a project's first deploy
  fromSha: text(),
  toSha: text().notNull(),
  // Newest first, as `git log` lists them
  commits: jsonb().$type<{ sha: string, subject: string }[]>().notNull().default([]),
  // Markdown release notes
  notes: text(),
  notesStatus: deploymentNotesStatus().notNull().default('pending'),
  readAt: timestamp('read_at', { withTimezone: true }),
  dismissedAt: timestamp('dismissed_at', { withTimezone: true }),
  createdAt: createdAt()
}, t => [unique('deployments_project_to_sha_unique').on(t.projectId, t.toSha)])
