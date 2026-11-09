import type { ParentRollup, Task } from '@corral/contracts'
import {
  checkEpicDependencies,
  deliveryCounts,
  hasPrToLand,
  isOnBoard,
  isTaskDone,
  markdownToRichText,
  parentHolds,
  parentStage,
  richTextToMarkdown,
  subtaskRefusal,
  taskRef,
  type Actor,
  type EpicReviewMode
} from '@corral/core'
import { schema, type EpicRow, type Executor, type ProjectRow, type TaskRow } from '@corral/db'
import { and, asc, eq, inArray, isNull, max, ne, sql } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { ApiFailure } from './errors.ts'
import { pullRequestUrl } from './github-urls.ts'
import { allocateTaskNumber } from './projects.ts'

const { acceptanceCriteria, auditLog, comments, epicDependencies, epics, runs, taskDependencies, taskDesignPins, taskSubmissions, tasks } = schema

// A task with sub-tasks (D31) is a `tasks` row with status `parent`, and its
// delivery record is the `epics` row whose taskId points back at it. Sub-tasks
// are tasks whose epicId points at that record. A parent never takes a run or
// a transition, so its stage is worked out here on read. Only this module
// reads that encoding.

export const isParent = (task: Pick<TaskRow, 'status'>): boolean => task.status === 'parent'

// Refused on a parent: it has sub-tasks, not work of its own (D31)
export function refuseOnParent(task: Pick<TaskRow, 'status'>, what: string): void {
  if (isParent(task)) throw new ApiFailure(409, { code: 'conflict', constraint: `parent_task_${what}` })
}

// The delivery record for a task about to gain subtasks, or for a plan's new
// parent. `taskId` is null while the plan's parent has no task row yet.
export async function createDelivery(tx: Executor, project: ProjectRow, record: { taskId: string | null, title: string, description: string, priority?: TaskRow['priority'], reviewMode?: EpicReviewMode | undefined }, actor: Actor): Promise<string> {
  const [row] = await tx.insert(epics).values({
    projectId: project.id, taskId: record.taskId, title: record.title, description: record.description,
    ...(record.priority && { priority: record.priority }),
    reviewMode: record.reviewMode ?? project.epicReviewModeDefault, createdBy: actor
  }).returning({ id: epics.id })
  return row!.id
}

async function createParent(tx: Executor, epic: EpicRow, actor: Actor): Promise<string> {
  const number = await allocateTaskNumber(tx, epic.projectId)
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

// What people wrote on a parent outlives a plan that drops or shrinks it
async function hasComments(tx: Executor, taskId: string): Promise<boolean> {
  const [comment] = await tx.select({ id: comments.id }).from(comments).where(eq(comments.taskId, taskId)).limit(1)
  return Boolean(comment)
}

// Deleting a parent keeps the row once anything happened to it besides being created
async function hasHistory(tx: Executor, taskId: string): Promise<boolean> {
  if (await hasComments(tx, taskId)) return true
  const [entry] = await tx.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.taskId, taskId), ne(auditLog.action, 'task.created'))).limit(1)
  return Boolean(entry)
}

// An epic the plan dropped takes its parent with it, unless the parent has a
// history, which leaves both for people to delete
export async function deleteEpicWithParent(tx: Executor, epicId: string): Promise<void> {
  const [epic] = await tx.select({ taskId: epics.taskId }).from(epics).where(eq(epics.id, epicId))
  const [parent] = epic?.taskId ? await tx.select({ status: tasks.status }).from(tasks).where(eq(tasks.id, epic.taskId)) : []
  if (epic?.taskId && parent && isParent(parent) && await hasComments(tx, epic.taskId)) return
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

// Deleting a parent (D10 "Deleting", D31): it goes once it has nothing left,
// so its sub-tasks are deleted first, and never with unmerged work on its
// branch. Returns whether its history keeps the row, and what to do with the
// delivery record once the row goes. Null for any other task.
export async function parentDeletion(tx: Executor, task: TaskRow): Promise<{ keepRow: boolean, release: () => Promise<void> } | null> {
  if (!isParent(task)) return null
  const [delivery] = await tx.select().from(epics).where(eq(epics.taskId, task.id)).for('update')
  if (!delivery) return null
  const [sub] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.epicId, delivery.id), isNull(tasks.deletedAt))).limit(1)
  if (sub) throw new ApiFailure(409, { code: 'conflict', constraint: 'parent_has_subtasks' })
  if (delivery.reviewState === 'merged') throw new ApiFailure(409, { code: 'conflict', constraint: 'parent_delivered' })
  if (delivery.branch) throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: `${delivery.branch} isn't merged, so deleting this task would lose its work. Close its PR and delete the branch first.` }] })
  const keepRow = await hasHistory(tx, task.id)
  // A soft-deleted sub-task that submitted commits keeps its epicId (tasks_integration_protocol)
  const [kept] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.epicId, delivery.id), sql`${tasks.integrationProtocol} > 0`)).limit(1)
  return {
    keepRow,
    release: async () => {
      if (kept) await tx.update(epics).set({ taskId: null }).where(eq(epics.id, delivery.id))
      else await tx.delete(epics).where(eq(epics.id, delivery.id))
    }
  }
}

// The parent shows what the delivery record says, whichever one was edited.
// Its rich text changes only if the Markdown really does, so a plan repeating
// it doesn't flatten it, and a task a plan will promote stays as it is.
export async function syncParentContent(tx: Executor, epicId: string, content: { title?: string | undefined, description?: string | undefined, priority?: TaskRow['priority'] | undefined }): Promise<void> {
  const [row] = await tx.select({ task: tasks }).from(epics).innerJoin(tasks, eq(tasks.id, epics.taskId)).where(eq(epics.id, epicId))
  if (!row || !isParent(row.task)) return
  const text = content.description
  await tx.update(tasks).set({
    ...(content.title !== undefined && { title: content.title }),
    ...(text !== undefined && text !== richTextToMarkdown(row.task.description) && { description: text.trim() ? markdownToRichText(text) : null }),
    ...(content.priority !== undefined && { priority: content.priority }),
    updatedAt: new Date()
  }).where(eq(tasks.id, row.task.id))
}

// A parent's edits reach its delivery record too
export async function syncDeliveryContent(tx: Executor, parent: Pick<TaskRow, 'id' | 'status'>, content: { title?: string | undefined, description?: unknown, priority?: TaskRow['priority'] | undefined }): Promise<void> {
  if (!isParent(parent)) return
  await tx.update(epics).set({
    ...(content.title !== undefined && { title: content.title }),
    ...(content.description !== undefined && { description: richTextToMarkdown(content.description) }),
    ...(content.priority !== undefined && { priority: content.priority }),
    updatedAt: new Date()
  }).where(eq(epics.taskId, parent.id))
}

// A cycle can run through a parent, which waits on its sub-tasks and its
// delivery record: task edges, parent edges and sub-tasks are one graph (D31).
// `changed` holds task edges this write is about to replace, `changedEpic` a
// parent's, and `promoting` tasks about to become parents.
export async function checkParentCycles(tx: Executor, project: Pick<ProjectRow, 'id'>, options: { changed?: ReadonlyMap<string, readonly string[]>, changedEpic?: { id: string, dependsOn: readonly string[] }, promoting?: ReadonlySet<string> } = {}): Promise<void> {
  const { changed = new Map(), changedEpic, promoting = new Set() } = options
  const rows = await tx.select({ id: tasks.id, epicId: tasks.epicId, status: tasks.status, type: tasks.type, deliveryOf: epics.id }).from(tasks)
    .leftJoin(epics, eq(epics.taskId, tasks.id))
    .where(and(eq(tasks.projectId, project.id), isNull(tasks.deletedAt)))
  const edges = await tx.select({ taskId: taskDependencies.taskId, dependsOnId: taskDependencies.dependsOnId }).from(taskDependencies).where(eq(taskDependencies.projectId, project.id))
  const parentEdges = await tx.select().from(epicDependencies).where(eq(epicDependencies.projectId, project.id))
  const projectEpics = await tx.select({ id: epics.id, title: epics.title }).from(epics).where(eq(epics.projectId, project.id))
  const dependsOn = Map.groupBy(edges, e => e.taskId)
  const epicGraph = new Map(projectEpics.map(e => [e.id, parentEdges.filter(d => d.epicId === e.id).map(d => d.dependsOnEpicId)]))
  if (changedEpic) epicGraph.set(changedEpic.id, [...new Set(changedEpic.dependsOn)])
  const problems = checkEpicDependencies(
    epicGraph,
    rows.map(({ deliveryOf, ...t }) => ({
      ...t,
      parentOf: isParent(t) || promoting.has(t.id) ? deliveryOf : null,
      dependsOn: changed.get(t.id) ?? (dependsOn.get(t.id) ?? []).map(e => e.dependsOnId)
    })),
    new Map(projectEpics.map(e => [e.id, e.title]))
  )
  if (problems.length > 0) throw new ApiFailure(400, { code: 'invalid_input', issues: problems.map(p => ({ message: `Dependency cycle or deadlock: ${p.epics.join(' → ') || 'a subtask waits on the task it belongs to'}` })) })
}

// Why a task can't gain sub-tasks, or null when it can (D31): nobody has
// started it, and nothing else depends on it staying a single task
export async function promotionRefusal(db: Executor, task: TaskRow): Promise<string | null> {
  const refusal = subtaskRefusal({ ...task, leased: task.leaseRunId !== null })
  if (refusal) return refusal
  const [run] = await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, task.id)).limit(1)
  const [submission] = await db.select({ id: taskSubmissions.id }).from(taskSubmissions).where(eq(taskSubmissions.taskId, task.id)).limit(1)
  if (run || submission || task.prNumber !== null) return 'This task has already had a run. Add a separate follow-up task instead.'
  const [pin] = await db.select({ taskId: taskDesignPins.taskId }).from(taskDesignPins).where(eq(taskDesignPins.taskId, task.id)).limit(1)
  if (pin) return 'A task pinned to a design can\'t gain subtasks.'
  return null
}

// Moves a task's work onto `firstSub` and makes it a parent. It keeps its ref,
// comments and attachments; its criteria, dependencies, human review and pause
// move, so promotion lowers no gate.
export async function promoteToParent(tx: Executor, project: ProjectRow, task: TaskRow, firstSub: string, actor: Actor): Promise<void> {
  const refusal = await promotionRefusal(tx, task)
  if (refusal) throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: refusal }] })
  const [{ moved } = { moved: 0 }] = await tx.select({ moved: max(acceptanceCriteria.position) }).from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, firstSub))
  await tx.update(acceptanceCriteria).set({ taskId: firstSub, position: sql`${acceptanceCriteria.position} + ${(moved ?? -1) + 1}`, updatedAt: new Date() }).where(eq(acceptanceCriteria.taskId, task.id))
  // The sub-task may already wait on the same work
  const edges = await tx.delete(taskDependencies).where(eq(taskDependencies.taskId, task.id)).returning()
  const moving = edges.filter(e => e.dependsOnId !== firstSub)
  if (moving.length > 0) await tx.insert(taskDependencies).values(moving.map(e => ({ projectId: e.projectId, taskId: firstSub, dependsOnId: e.dependsOnId }))).onConflictDoNothing()
  if (task.humanReview || task.paused) await tx.update(tasks).set({ ...task.humanReview && { humanReview: true }, ...task.paused && { paused: true } }).where(eq(tasks.id, firstSub))
  await tx.update(tasks).set({ status: 'parent', humanReview: false, paused: false, statusReason: null, updatedAt: new Date() }).where(eq(tasks.id, task.id))
  await appendAudit(tx, { projectId: task.projectId, taskId: task.id, actor }, auditEvent('task.promoted', { firstSub, from: task.status }))
  await checkParentCycles(tx, project)
}

// The board of a task with subtasks: its live subtasks past Draft and Backlog
export async function epicBoard(db: Executor, epicId: string): Promise<TaskRow[]> {
  const rows = await db.select().from(tasks).where(and(eq(tasks.epicId, epicId), isNull(tasks.deletedAt))).orderBy(asc(tasks.number))
  return rows.filter(t => isOnBoard(t.status))
}

// When a parent landed. updatedAt moves with any edit, so a merged row with no
// time of its own uses when it began, and sorts the same every time.
export const deliveredAt = (delivery: Pick<EpicRow, 'mergedAt' | 'reviewState' | 'createdAt'>): Date | null => delivery.mergedAt ?? (delivery.reviewState === 'merged' ? delivery.createdAt : null)

// A parent with no PR to merge is delivered by its last sub-task landing
export async function markDelivered(db: Executor, epicId: string): Promise<void> {
  const [epic] = await db.select().from(epics).where(eq(epics.id, epicId))
  if (!epic || deliveredAt(epic) || hasPrToLand(epic)) return
  const live = await db.select({ status: tasks.status, type: tasks.type }).from(tasks).where(and(eq(tasks.epicId, epicId), isNull(tasks.deletedAt)))
  if (live.length > 0 && !parentHolds(epic, live)) await db.update(epics).set({ mergedAt: new Date(), updatedAt: new Date() }).where(eq(epics.id, epicId))
}

// Tasks that wait on a parent, once its delivery record is done
export async function parentDependents(db: Executor, epicId: string): Promise<string[]> {
  return (await db.select({ id: taskDependencies.taskId }).from(taskDependencies)
    .innerJoin(epics, eq(epics.taskId, taskDependencies.dependsOnId))
    .where(eq(epics.id, epicId))).map(t => t.id)
}

type SubRow = Pick<TaskRow, 'epicId' | 'status' | 'type' | 'deletedAt'>

interface ParentFacts {
  // Rollups by parent task ID
  rollups: Map<string, ParentRollup>
  // What a parent shows of its delivery record
  delivery: Map<string, Pick<Task, 'pr' | 'mergeCommitSha' | 'mergedAt' | 'branch'>>
  // Parents by delivery record, for their sub-tasks
  parents: Map<string, NonNullable<Task['parentTask']>>
}

export async function parentFacts(db: Executor, project: { prefix: string, repository: string }, rows: Pick<TaskRow, 'id' | 'status' | 'epicId'>[]): Promise<ParentFacts> {
  const parentIds = rows.filter(isParent).map(r => r.id)
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
    const counted = live.filter(t => isOnBoard(t.status))
    const counts = { reviewMode: delivery.reviewMode, branch: delivery.branch, reviewState: delivery.reviewState, ...deliveryCounts(live) }
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
      pr: delivery.prNumber ? { number: delivery.prNumber, url: pullRequestUrl(project.repository, delivery.prNumber) } : null,
      mergeCommitSha: delivery.mergeCommitSha,
      mergedAt: deliveredAt(delivery)?.toISOString() ?? null,
      branch: delivery.branch
    })
  }
  return facts
}
