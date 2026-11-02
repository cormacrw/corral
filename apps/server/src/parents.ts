import type { ParentRollup, Task } from '@corral/contracts'
import { isTaskDone, markdownToRichText, parentStage, richTextToPlainText, taskRef, type Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, eq, exists, inArray, isNull, not, or, sql, type SQL } from 'drizzle-orm'
import { alias, type AnyPgColumn } from 'drizzle-orm/pg-core'
import { appendAudit, auditEvent } from './audit.ts'
import { ApiFailure } from './errors.ts'
import { holdsEpicOpen } from './epic-review-state.ts'

const { epics, projects, taskDependencies, tasks } = schema

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

// An epic the plan dropped takes its parent with it
export async function deleteEpicWithParent(tx: Executor, epicId: string): Promise<void> {
  const [epic] = await tx.select({ taskId: epics.taskId }).from(epics).where(eq(epics.id, epicId))
  await tx.delete(epics).where(eq(epics.id, epicId))
  // A task the plan would have promoted stays as it was
  if (epic?.taskId) await tx.delete(tasks).where(and(eq(tasks.id, epic.taskId), eq(tasks.status, 'parent')))
}

// A plan that shrinks an unstarted epic to one task has no parent left to show
export async function collapseUnstartedParent(tx: Executor, epicId: string): Promise<void> {
  const [epic] = await tx.select().from(epics).where(eq(epics.id, epicId)).for('update')
  if (!epic?.taskId || epic.branch) return
  const live = await tx.select({ status: tasks.status }).from(tasks).where(and(eq(tasks.epicId, epicId), isNull(tasks.deletedAt))).limit(2)
  if (live.length !== 1 || live[0]!.status !== 'draft') return
  await tx.update(epics).set({ taskId: null }).where(eq(epics.id, epicId))
  await tx.delete(tasks).where(and(eq(tasks.id, epic.taskId), eq(tasks.status, 'parent')))
}

// The parent shows what the delivery record says, whichever one was edited
export async function syncParentContent(tx: Executor, epicId: string, content: { title?: string | undefined, description?: string | undefined, priority?: TaskRow['priority'] | undefined }): Promise<void> {
  const [epic] = await tx.select({ taskId: epics.taskId }).from(epics).where(eq(epics.id, epicId))
  if (!epic?.taskId) return
  await tx.update(tasks).set({
    ...(content.title !== undefined && { title: content.title }),
    ...(content.description !== undefined && { description: content.description.trim() ? markdownToRichText(content.description) : null }),
    ...(content.priority !== undefined && { priority: content.priority }),
    updatedAt: new Date()
  }).where(eq(tasks.id, epic.taskId))
}

// A parent's edits reach its delivery record too
export async function syncDeliveryContent(tx: Executor, parentId: string, content: { title?: string | undefined, description?: unknown, priority?: TaskRow['priority'] | undefined }): Promise<void> {
  await tx.update(epics).set({
    ...(content.title !== undefined && { title: content.title }),
    ...(content.description !== undefined && { description: richTextToPlainText(content.description) }),
    ...(content.priority !== undefined && { priority: content.priority }),
    updatedAt: new Date()
  }).where(eq(epics.taskId, parentId))
}

// True while a dependency that's a parent still holds its dependents: until
// its work is on the target branch. holdsEpicOpen ignores unstarted sub-tasks,
// so a parent with nothing finished yet holds them too. One with no live
// sub-tasks has nothing to wait for.
export function parentHolds(db: Executor, dependency: { id: AnyPgColumn, status: AnyPgColumn }): SQL {
  const delivery = alias(epics, 'parent_delivery')
  const sub = alias(tasks, 'parent_sub')
  const done = alias(tasks, 'parent_done')
  const live = db.select({ one: sql`1` }).from(sub).where(and(eq(sub.epicId, delivery.id), isNull(sub.deletedAt)))
  const finished = db.select({ one: sql`1` }).from(done).where(and(eq(done.epicId, delivery.id), isNull(done.deletedAt), or(
    and(eq(done.type, 'design'), eq(done.status, 'approved')),
    and(inArray(done.type, ['task', 'bug', 'spike']), eq(done.status, 'merged'))
  )))
  const open = db.select({ one: sql`1` }).from(sub).where(and(eq(sub.epicId, delivery.id), holdsEpicOpen(sub, delivery)))
  return and(eq(dependency.status, 'parent'), exists(db.select({ one: sql`1` }).from(delivery).where(and(
    eq(delivery.taskId, dependency.id),
    or(exists(open), and(exists(live), not(exists(finished))))
  ))))!
}

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
      mergedAt: (delivery.mergedAt ?? (delivery.reviewState === 'merged' ? delivery.updatedAt : null))?.toISOString() ?? null,
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
