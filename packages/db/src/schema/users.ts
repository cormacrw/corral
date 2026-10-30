import { sql } from 'drizzle-orm'
import { check, pgTable, text, uuid } from 'drizzle-orm/pg-core'
import { createdAt } from './columns.ts'

// People. The POC has one, but nothing assumes that (D1).
export const users = pgTable('users', {
  id: uuid().primaryKey().defaultRandom(),
  name: text().notNull(),
  // Profile picture: a blob hash and its image type, or none
  avatarBlob: text(),
  avatarContentType: text(),
  createdAt: createdAt()
}, t => [check('users_avatar_paired', sql`(${t.avatarBlob} is null) = (${t.avatarContentType} is null)`)])
