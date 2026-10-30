import type { Actor } from '@corral/core'
import { jsonb, timestamp } from 'drizzle-orm/pg-core'

export const createdAt = () => timestamp('created_at', { withTimezone: true }).notNull().defaultNow()
export const updatedAt = () => timestamp('updated_at', { withTimezone: true }).notNull().defaultNow()
// Who did it (D1). Stored whole, so agents and system components need no table of their own.
export const actor = (name: string) => jsonb(name).$type<Actor>().notNull()
