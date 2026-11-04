import { pgTable, text, timestamp } from 'drizzle-orm/pg-core'
import { createdAt } from './columns.ts'

// One durable claim/result per arrival, including failed/offline attempts.
// Keys include the entity, item type and arrival time, so late jobs cannot
// replace the message for a newer review of the same task.
export const inboxMessages = pgTable('inbox_messages', {
  arrival: text().primaryKey(),
  message: text().notNull(),
  createdAt: createdAt()
})

// When the human last opened an Inbox item, by `<type>:<id>` (the item's type
// and ID as the Inbox lists them). Items are derived, not stored, so their read
// state lives here. An item is unread until opened, and again once it arrives
// anew after that, so a task back in Human review shows as new. Plan threads
// and release notes keep their own flags (plan_sessions, deployments).
export const inboxReads = pgTable('inbox_reads', {
  key: text().primaryKey(),
  readAt: timestamp('read_at', { withTimezone: true }).notNull().defaultNow()
})
