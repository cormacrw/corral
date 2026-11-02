import { DONE_STATUS } from '@corral/core'
import { and, eq, ne, not, or, type AnyColumn } from 'drizzle-orm'

// A parent is never finished by type: parentHolds decides for one (D31)
export function unfinishedTask(table: { type: AnyColumn, status: AnyColumn }) {
  return and(ne(table.status, 'parent'), not(or(...Object.entries(DONE_STATUS).map(([type, status]) =>
    and(eq(table.type, type), eq(table.status, status))
  ))!))!
}
