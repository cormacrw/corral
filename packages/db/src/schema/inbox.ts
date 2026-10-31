import { pgTable, text } from 'drizzle-orm/pg-core'
import { createdAt } from './columns.ts'

// One durable claim/result per arrival, including failed/offline attempts.
// Keys include the entity, item type and arrival time, so late jobs cannot
// replace the message for a newer review of the same task.
export const inboxMessages = pgTable('inbox_messages', {
  arrival: text().primaryKey(),
  message: text().notNull(),
  createdAt: createdAt()
})
