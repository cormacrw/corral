import type { ParentRollup, Task } from '@corral/contracts'
import { isTaskDone, markdownToRichText, parentStage, richTextToMarkdown, taskRef, type Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, eq, exists, inArray, isNull, or, sql, type SQL } from 'drizzle-orm'
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { appendAudit, auditEvent } from './audit.ts'
import { unfinishedTask } from './completion.ts'
import { ApiFailure } from './errors.ts'
import { holdsEpicOpen } from './epic-review-state.ts'

const { comments, epics, projects, taskDependencies, tasks } = schema

type TaskRow = typeof tasks.$inferSelect
type EpicRow = typeof epics.$inferSelect

// A task with sub-tasks (D31) is a `tasks` row with status `parent`, and its
// delivery record is the `epics` row whose taskId points back at it. Sub-tasks
// are tasks whose epicId points at that record. A parent never takes a run or
// a transition, so its stage is worked out here on read.

// Takes the project row lock, which is what keeps task numbers sequential
async function nextNumber(tx: Executor, projectId: string): Promise<number> {
  const [allocated] = await tx.update(projects)
    .set({ nextTaskNumber: sql`${projects.nextTaskNumber} + 1` })
    .where(eq(projects.id, projectId))
    .returning({ number: sql<number>`${projects.nextTaskNumber} - 1` })
  return allocated!.number
}

// The epic's parent row, for an epic that doesn't have one yet
export async function createParent(tx: Executor, epic: EpicRow, actor: Actor): Promise<string> {
  const number = await nextNumber(tx, epic.projectId)
  const description = epic.description.trim() ? markdownToRichText(epic.description) : null
  const [row] = await tx.insert(tasks).values({
    projectId: epic.projectId, number, title: epic.title, description, status: 'parent', type: 'task', priority: epic.priority, createdBy: actor
  }).returning({ id: tasks.id })
  await tx.update(epics).set({ taskId: row!.id }).where(eq(epics.id, epic.id))
  await appendAudit(tx, { projectId: epic.projectId, taskId: row!.id, actor }, auditEvent('task.created', { number }))
  return row!.id
}

// A single unit of work stays one task (D31): an epic gets its parent with its
// second task, so Corral's own fix tasks make a parent of a one-task epic too
export async function ensureParent(tx: Executor, epicId: string, actor: Actor): Promise<void> {
  const [epic] = await tx.select().from(epics).where(eq(epics.id, epicId)).for('update')
  if (!epic || epic.taskId) return
  const live = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.epicId, epicId), isNull(tasks.deletedAt))).limit(2)
  if (live.length >= 2) await createParent(tx, epic, actor)
}

// What people wrote on a parent outlives the plan that made it, which is left
// empty for them to delete
async function hasComments(tx: Executor, taskId: string): Promise<boolean> {
  const [comment] = await tx.select({ id: comments.id }).from(comments).where(eq(comments.taskId, taskId)).limit(1)
  return Boolean(comment)
}

// An epic the plan dropped takes its parent with it
export async function deleteEpicWithParent(tx: Executor, epicId: string): Promise<void> {
  const [epic] = await tx.select({ taskId: epics.taskId }).from(epics).where(eq(epics.id, epicId))
  const [parent] = epic?.taskId ? await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, epic.taskId)) : []
  if (epic?.taskId && parent?.status === 'parent' && await hasComments(tx, epic.taskId)) return
  await tx.delete(epics).where(eq(epics.id, epicId))
  // A task the plan would have promoted stays as it was, unless it was the plan's own Draft
  if (epic?.taskId) await tx.delete(tasks).where(and(eq(tasks.id, epic.taskId), inArray(tasks.status, ['parent', 'draft'])))
}

// A plan that shrinks an unstarted epic to one task has no parent left to show
export async function collapseUnstartedParent(tx: Executor, epicId: string): Promise<void> {
  const [epic] = await tx.select().from(epics).where(eq(epics.id, epicId)).for('update')
  if (!epic?.taskId || epic.branch) return
  const live = await tx.select({ status: tasks.status }).from(tasks).where(and(eq(tasks.epicId, epicId), isNull(tasks.deletedAt))).limit(2)
  if (live.length !== 1 || live[0]!.status !== 'draft' || await hasComments(tx, epic.taskId)) return
  await tx.update(epics).set({ taskId: null }).where(eq(epics.id, epicId))
  await tx.delete(tasks).where(and(eq(tasks.id, epic.taskId), eq(tasks.status, 'parent')))
}

// The parent shows what the delivery record says, whichever one was edited.
// Its rich text changes only if the Markdown really does, so a plan repeating
// it doesn't flatten it, and a task a plan will promote stays as it is.
export async function syncParentContent(tx: Executor, epicId: string, content: { title?: string | undefined, description?: string | undefined, priority?: TaskRow['priority'] | undefined }): Promise<void> {
  const [row] = await tx.select({ task: tasks }).from(epics).innerJoin(tasks, eq(tasks.id, epics.taskId)).where(eq(epics.id, epicId))
  if (row?.task.status !== 'parent') return
  const text = content.description
  await tx.update(tasks).set({
    ...(content.title !== undefined && { title: content.title }),
    ...(text !== undefined && text !== richTextToMarkdown(row.task.description) && { description: text.trim() ? markdownToRichText(text) : null }),
    ...(content.priority !== undefined && { priority: content.priority }),
    updatedAt: new Date()
  }).where(eq(tasks.id, row.task.id))
}

// A parent's edits reach its delivery record too
export async function syncDeliveryContent(tx: Executor, parentId: string, content: { title?: string | undefined, description?: unknown, priority?: TaskRow['priority'] | undefined }): Promise<void> {
  await tx.update(epics).set({
    ...(content.title !== undefined && { title: content.title }),
    ...(content.description !== undefined && { description: richTextToMarkdown(content.description) }),
    ...(content.priority !== undefined && { priority: content.priority }),
    updatedAt: new Date()
  }).where(eq(epics.taskId, parentId))
}

// True while a dependency that's a parent still holds its dependents: until
// every live sub-task is done, Backlog and Draft ones too, and its work is on
// the target branch. One with no live sub-tasks has nothing to wait for.
export function parentHolds(db: Executor, dependency: { id: AnyPgColumn, status: AnyPgColumn }): SQL {
  const delivery = alias(epics, 'parent_delivery')
  const sub = alias(tasks, 'parent_sub')
  const unfinished = db.select({ one: sql`1` }).from(sub).where(and(eq(sub.epicId, delivery.id), isNull(sub.deletedAt), unfinishedTask(sub)))
  const open = db.select({ one: sql`1` }).from(sub).where(and(eq(sub.epicId, delivery.id), holdsEpicOpen(sub, delivery)))
  return and(eq(dependency.status, 'parent'), exists(db.select({ one: sql`1` }).from(delivery).where(and(
    eq(delivery.taskId, dependency.id),
    or(exists(open), exists(unfinished))
  ))))!
}

// A direct parent has no PR to merge, so its last sub-task landing delivers it
export async function markDelivered(db: Executor, epicId: string): Promise<void> {
  const [epic] = await db.select().from(epics).where(eq(epics.id, epicId))
  if (!epic || epic.mergedAt || (epic.reviewMode !== 'direct' && epic.branch)) return
  const live = await db.select({ status: tasks.status, type: tasks.type }).from(tasks).where(and(eq(tasks.epicId, epicId), isNull(tasks.deletedAt)))
  if (live.length > 0 && live.every(isTaskDone)) await db.update(epics).set({ mergedAt: new Date(), updatedAt: new Date() }).where(eq(epics.id, epicId))
}

// When a parent landed. updatedAt moves with any edit, so a merged row with no
// time of its own uses when it began, and sorts the same every time.
export const deliveredAt = (delivery: Pick<EpicRow, 'mergedAt' | 'reviewState' | 'createdAt'>): Date | null => delivery.mergedAt ?? (delivery.reviewState === 'merged' ? delivery.createdAt : null)

type SubRow = Pick<TaskRow, 'epicId' | 'status' | 'type' | 'deletedAt'>

export interface ParentFacts {
  // Rollups by parent task ID
  rollups: Map<string, ParentRollup>
  // What a parent shows of its delivery record
  delivery: Map<string, Pick<Task, 'pr' | 'mergeCommitSha' | 'mergedAt' | 'branch'>>
  // Parents by delivery record, for their sub-tasks
  parents: Map<string, NonNullable<Task['parentTask']>>
}

export async function parentFacts(db: Executor, project: { prefix: string, repository: string }, rows: Pick<TaskRow, 'id' | 'status' | 'epicId'>[]): Promise<ParentFacts> {
  const parentIds = rows.filter(r => r.status === 'parent').map(r => r.id)
  const epicIds = [...new Set(rows.flatMap(r => r.epicId ? [r.epicId] : []))]
  const facts: ParentFacts = { rollups: new Map(), delivery: new Map(), parents: new Map() }
  if (epicIds.length > 0) {
    const found = await db.select({ epicId: epics.id, id: tasks.id, number: tasks.number, title: tasks.title }).from(epics)
      .innerJoin(tasks, eq(tasks.id, epics.taskId))
      .where(and(inArray(epics.id, epicIds), isNull(tasks.deletedAt)))
    for (const { epicId, id, number, title } of found) facts.parents.set(epicId, { id, ref: taskRef(project.prefix, number), title })
  }
  if (parentIds.length === 0) return facts
  const deliveries = await db.select().from(epics).where(inArray(epics.taskId, parentIds))
  const subs: SubRow[] = deliveries.length === 0
    ? []
    : await db.select({ epicId: tasks.epicId, status: tasks.status, type: tasks.type, deletedAt: tasks.deletedAt }).from(tasks).where(inArray(tasks.epicId, deliveries.map(d => d.id)))
  const subsOf = Map.groupBy(subs.filter(s => !s.deletedAt), s => s.epicId!)
  for (const delivery of deliveries) {
    const live = subsOf.get(delivery.id) ?? []
    const counted = live.filter(t => t.status !== 'draft' && t.status !== 'backlog')
    const counts = { reviewMode: delivery.reviewMode, branch: delivery.branch, reviewState: delivery.reviewState, taskCount: counted.length, mergedCount: counted.filter(isTaskDone).length }
    facts.rollups.set(delivery.taskId!, {
      epicId: delivery.id,
      stage: parentStage(counts, counted),
      reviewMode: delivery.reviewMode,
      done: live.filter(isTaskDone).length,
      total: live.length,
      planned: counted.length > 0,
      drafting: live.length > 0 && live.every(t => t.status === 'draft')
    })
    facts.delivery.set(delivery.taskId!, {
      pr: delivery.prNumber ? { number: delivery.prNumber, url: `https://github.com/${project.repository}/pull/${delivery.prNumber}` } : null,
      mergeCommitSha: delivery.mergeCommitSha,
      mergedAt: deliveredAt(delivery)?.toISOString() ?? null,
      branch: delivery.branch
    })
  }
  return facts
}

// Refused on a parent: it has sub-tasks, not work of its own (D31)
export function refuseOnParent(task: Pick<TaskRow, 'status'>, what: string): void {
  if (task.status === 'parent') throw new ApiFailure(409, { code: 'conflict', constraint: `parent_task_${what}` })
}

// Tasks that wait on a parent, once its delivery record is done
export async function parentDependents(db: Executor, epicId: string): Promise<string[]> {
  return (await db.select({ id: taskDependencies.taskId }).from(taskDependencies)
    .innerJoin(epics, eq(epics.taskId, taskDependencies.dependsOnId))
    .where(eq(epics.id, epicId))).map(t => t.id)
}
