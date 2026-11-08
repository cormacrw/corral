import type { Comment } from '@corral/contracts'
import type { Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { asc, eq, inArray, sql } from 'drizzle-orm'

const { comments } = schema

// Stamped with the clock, not the transaction's start, so comments posted in
// one transaction list in the order they were added
export async function addComment(db: Executor, taskId: string, input: { body: string, pinned: boolean }, author: Actor): Promise<Comment> {
  const [row] = await db.insert(comments).values({ taskId, author, body: input.body, pinned: input.pinned, createdAt: sql`clock_timestamp()` }).returning()
  return toComment(row!)
}

// Stamped with the transaction's start, like the audit entry written beside it,
// which is how the Inbox pairs a human's answer with its transition
export async function addCommentWithTransition(db: Executor, taskId: string, input: { body: string, pinned?: boolean }, author: Actor): Promise<void> {
  await db.insert(comments).values({ taskId, author, body: input.body, pinned: input.pinned ?? false })
}

function toComment(row: typeof comments.$inferSelect): Comment {
  return { id: row.id, taskId: row.taskId, author: row.author, body: row.body, pinned: row.pinned, createdAt: row.createdAt.toISOString() }
}

export async function listComments(db: Executor, taskId: string): Promise<Comment[]> {
  const rows = await db.select().from(comments).where(eq(comments.taskId, taskId)).orderBy(asc(comments.createdAt))
  return rows.map(toComment)
}

// Each task's comments, oldest first
export async function listCommentsFor(db: Executor, taskIds: string[]): Promise<Map<string, Comment[]>> {
  if (taskIds.length === 0) return new Map()
  const rows = await db.select().from(comments).where(inArray(comments.taskId, taskIds)).orderBy(asc(comments.createdAt), asc(comments.id))
  return Map.groupBy(rows.map(toComment), c => c.taskId)
}
