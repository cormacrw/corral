import { DONE_STATUS } from '@corral/core'
import { and, eq, not, or, type AnyColumn } from 'drizzle-orm'

export function unfinishedTask(table: { type: AnyColumn, status: AnyColumn }) {
  return not(or(...Object.entries(DONE_STATUS).map(([type, status]) =>
    and(eq(table.type, type), eq(table.status, status))
  ))!)
}
