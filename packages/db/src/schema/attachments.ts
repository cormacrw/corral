import { index, integer, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { actor, createdAt } from './columns.ts'
import { projects } from './projects.ts'

// Images pasted into task descriptions and comments. The bytes are an
// immutable blob (D8), so the same picture twice is stored once; each
// upload still gets its own row, which text references as attachment:<id>.
export const attachments = pgTable('attachments', {
  id: uuid().primaryKey().defaultRandom(),
  projectId: uuid().notNull().references(() => projects.id, { onDelete: 'cascade' }),
  // sha256 in the blob store
  blob: text().notNull(),
  mimeType: text().notNull(),
  fileName: text().notNull(),
  byteSize: integer().notNull(),
  createdBy: actor('created_by'),
  createdAt: createdAt()
}, t => [index().on(t.projectId)])
