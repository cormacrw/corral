import type { AuditEntry, Comment, CreateTaskInput, HumanTransitionInput, PatchTaskInput, Task } from '@corral/contracts'
import { createTaskInput } from '@corral/contracts'
import {
  checkDependencies,
  createTask as createTaskState,
  DEPENDENCY_DELETED_REASON,
  deletionFor,
  richTextToPlainText,
  taskRef,
  transition,
  upgradePlainMarkdown,
  type Actor,
  type TaskEvent,
  type TaskState,
  type TaskStatus
} from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, desc, eq, inArray, isNull, ne, sql } from 'drizzle-orm'
import { ApiFailure, notFound } from './errors.ts'
import { toReview } from './runs.ts'

const { acceptanceCriteria, auditLog, comments, epics, projects, reviews, taskDependencies, tasks } = schema

type TaskRow = typeof tasks.$inferSelect
type ProjectRow = typeof projects.$inferSelect

export type TaskView = 'board' | 'backlog' | 'all'
export type { ProjectRow, TaskRow }

export function toTaskState(row: TaskRow): TaskState {
  return {
    status: row.status,
    humanReview: row.humanReview,
    reviewRounds: row.reviewRounds,
    failedRuns: row.failedRuns,
    reason: row.statusReason,
    type: row.type
  }
}

// Builds API tasks for rows of one project, loading criteria and dependencies in bulk
export async function toTasks(db: Executor, project: ProjectRow, rows: TaskRow[]): Promise<Task[]> {
  if (rows.length === 0) return []
  const ids = rows.map(r => r.id)
  const criteria = await db.select().from(acceptanceCriteria)
    .where(inArray(acceptanceCriteria.taskId, ids))
    .orderBy(asc(acceptanceCriteria.position))
  const dependencies = await db
    .select({ taskId: taskDependencies.taskId, number: tasks.number })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnId))
    .where(inArray(taskDependencies.taskId, ids))
    .orderBy(asc(tasks.number))
  // Newest first, so the first row per task is its latest review
  const reviewRows = await db.select().from(reviews).where(inArray(reviews.taskId, ids)).orderBy(desc(reviews.createdAt))

  return rows.map((row) => {
    const latest = reviewRows.find(r => r.taskId === row.id) ?? null
    // A verdict only describes the commit it was given for
    const current = latest && latest.headSha === row.headSha ? latest : null
    return toTask(project, row, criteria, dependencies, latest, current)
  })
}

function toTask(
  project: ProjectRow,
  row: TaskRow,
  criteria: (typeof acceptanceCriteria.$inferSelect)[],
  dependencies: { taskId: string, number: number }[],
  latest: typeof reviews.$inferSelect | null,
  current: typeof reviews.$inferSelect | null
): Task {
  return {
    id: row.id,
    projectId: row.projectId,
    ref: taskRef(project.prefix, row.number),
    number: row.number,
    title: row.title,
    description: upgradePlainMarkdown(row.description),
    status: row.status,
    priority: row.priority,
    type: row.type,
    epicId: row.epicId,
    humanReview: row.humanReview,
    reviewRounds: row.reviewRounds,
    failedRuns: row.failedRuns,
    statusReason: row.statusReason,
    paused: row.paused,
    branch: row.branch,
    prNumber: row.prNumber,
    prUrl: row.prUrl,
    acceptanceCriteria: criteria
      .filter(c => c.taskId === row.id)
      .map(c => ({ id: c.id, position: c.position, text: c.text, met: current?.criteria.find(v => v.criterionId === c.id)?.met ?? null })),
    dependsOn: dependencies.filter(d => d.taskId === row.id).map(d => taskRef(project.prefix, d.number)),
    lease: row.leaseRunId && row.leaseRole && row.leaseExpiresAt
      ? { runId: row.leaseRunId, role: row.leaseRole, expiresAt: row.leaseExpiresAt.toISOString() }
      : null,
    headSha: row.headSha,
    latestReview: latest ? toReview(latest) : null,
    mergeCommitSha: row.mergeCommitSha,
    mergedAt: row.mergedAt?.toISOString() ?? null,
    gateChecks: row.gateChecks,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

export async function loadTask(db: Executor, taskId: string): Promise<Task> {
  const [found] = await db.select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
  if (!found) throw notFound()
  return (await toTasks(db, found.project, [found.task]))[0]!
}

export async function findTaskId(db: Executor, projectId: string, number: number): Promise<string> {
  const [row] = await db.select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.number, number), isNull(tasks.deletedAt)))
  if (!row) throw notFound()
  return row.id
}

export async function listTasks(db: Executor, project: ProjectRow, view: TaskView): Promise<Task[]> {
  const rows = await db.select().from(tasks)
    .where(and(
      eq(tasks.projectId, project.id),
      isNull(tasks.deletedAt),
      // Drafts are seen only in the plan that proposed them
      ne(tasks.status, 'draft'),
      view === 'board' ? ne(tasks.status, 'backlog') : view === 'backlog' ? eq(tasks.status, 'backlog') : undefined
    ))
    .orderBy(asc(tasks.number))
  return toTasks(db, project, rows)
}

// New tasks start in Backlog, or as Drafts for the PM's plans (D10).
// Returns the new task's ID.
export async function createTask(db: Executor, project: ProjectRow, rawInput: CreateTaskInput, actor: Actor, options: { draft?: boolean } = {}): Promise<string> {
  const input = createTaskInput.parse(rawInput)
  const created = createTaskState(actor, input.humanReview ?? project.humanReviewDefault, options.draft)
  if (!created.ok) throw new ApiFailure(409, { code: 'transition_rejected', reason: created.error })

  return db.transaction(async (tx) => {
    // The project row lock makes numbers sequential under concurrent creates
    const [allocated] = await tx.update(projects)
      .set({ nextTaskNumber: sql`${projects.nextTaskNumber} + 1` })
      .where(eq(projects.id, project.id))
      .returning({ number: sql<number>`${projects.nextTaskNumber} - 1` })

    if (input.epicId) {
      const [epic] = await tx.select({ id: epics.id }).from(epics)
        .where(and(eq(epics.id, input.epicId), eq(epics.projectId, project.id)))
      if (!epic) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['epicId'], message: 'Unknown epic' }] })
    }

    // A brand-new task has no dependents, so it can't close a cycle; it can
    // only point at tasks that don't exist
    const numbers = [...new Set(input.dependsOn)]
    const dependencies = numbers.length === 0
      ? []
      : await tx.select({ id: tasks.id, number: tasks.number }).from(tasks)
          .where(and(eq(tasks.projectId, project.id), inArray(tasks.number, numbers), isNull(tasks.deletedAt)))
    const unknown = numbers.filter(n => !dependencies.some(d => d.number === n))
    if (unknown.length > 0) {
      throw new ApiFailure(400, {
        code: 'invalid_dependencies',
        problems: unknown.map(n => ({ code: 'unknown_dependency', dependsOn: taskRef(project.prefix, n) }))
      })
    }

    const state = created.task
    const [row] = await tx.insert(tasks).values({
      projectId: project.id,
      number: allocated!.number,
      title: input.title,
      description: input.description,
      type: input.type,
      priority: input.priority,
      epicId: input.epicId,
      status: state.status,
      humanReview: state.humanReview,
      createdBy: actor
    }).returning()
    const taskId = row!.id

    if (input.acceptanceCriteria.length > 0) {
      await tx.insert(acceptanceCriteria).values(
        input.acceptanceCriteria.map((text, position) => ({ taskId, position, text }))
      )
    }
    if (dependencies.length > 0) {
      await tx.insert(taskDependencies).values(dependencies.map(d => ({ taskId, dependsOnId: d.id })))
    }
    await tx.insert(auditLog).values({ projectId: project.id, taskId, actor, action: 'task.created', detail: { number: row!.number } })
    return taskId
  })
}

// Applies a D10 transition the human asked for. The row is locked for the
// whole check-and-write, and core decides whether the transition is allowed.
export async function transitionTask(db: Executor, taskId: string, input: HumanTransitionInput, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const { task, project } = await lockTask(tx, taskId)
    await applyTransition(tx, task, project, await humanEvent(tx, task, input), actor, { event: input })
  })
}

// Locks a task row for a check-and-write inside a transaction
export async function lockTask(tx: Executor, taskId: string): Promise<{ task: TaskRow, project: ProjectRow }> {
  const [found] = await tx.select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
    .for('update', { of: tasks })
  if (!found) throw notFound()
  return found
}

// Runs an event through core and writes the result with an audit entry.
// Every status change in Corral goes through here (D10). Throws an
// ApiFailure when core rejects it.
export async function applyTransition(
  tx: Executor,
  task: TaskRow,
  project: ProjectRow,
  event: TaskEvent,
  actor: Actor,
  detail: Record<string, unknown> = { event: event.type }
): Promise<TaskState> {
  const result = transition(toTaskState(task), event, actor, {
    reviewRoundCap: project.reviewRoundCap,
    failedRunCap: project.failedRunCap
  })
  if (!result.ok) throw new ApiFailure(409, { code: 'transition_rejected', reason: result.error })

  const next = result.task
  await tx.update(tasks).set({
    status: next.status,
    reviewRounds: next.reviewRounds,
    failedRuns: next.failedRuns,
    statusReason: next.reason,
    // A spike finishes without a merge (D19); this is when it finished
    ...(task.type === 'spike' && next.status === 'merged' && task.status !== 'merged' && { mergedAt: new Date() }),
    updatedAt: new Date()
  }).where(eq(tasks.id, task.id))
  await tx.insert(auditLog).values({
    projectId: project.id,
    taskId: task.id,
    actor,
    action: 'task.transition',
    detail: { ...detail, from: task.status, to: next.status satisfies TaskStatus }
  })
  return next
}

// design/task.md: a PATCH per field. Criteria keep their IDs (and so their
// evidence and verdicts) when passed back with the same ID.
export async function patchTask(db: Executor, project: ProjectRow, taskId: string, input: PatchTaskInput, actor: Actor): Promise<void> {
  await db.transaction(async (tx) => {
    const { task } = await lockTask(tx, taskId)
    // Merged is final (D10): the record stays as it shipped; comments still work
    if (task.status === 'merged') throw new ApiFailure(409, { code: 'conflict', constraint: 'task_merged' })
    const { acceptanceCriteria: criteriaInput, dependsOn, ...fields } = input
    if (fields.epicId) {
      const [epic] = await tx.select({ id: epics.id }).from(epics).where(and(eq(epics.id, fields.epicId), eq(epics.projectId, project.id)))
      if (!epic) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['epicId'], message: 'Unknown epic' }] })
    }
    if (Object.keys(fields).length > 0) {
      await tx.update(tasks).set({ ...fields, updatedAt: new Date() }).where(eq(tasks.id, taskId))
    }
    if (criteriaInput) {
      const existing = await tx.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, taskId))
      const keep = new Set(criteriaInput.map(c => c.id).filter((id): id is string => Boolean(id)))
      const gone = existing.filter(c => !keep.has(c.id)).map(c => c.id)
      if (gone.length > 0) await tx.delete(acceptanceCriteria).where(inArray(acceptanceCriteria.id, gone))
      for (const [position, criterion] of criteriaInput.entries()) {
        if (criterion.id && existing.some(c => c.id === criterion.id)) {
          await tx.update(acceptanceCriteria).set({ position, text: criterion.text, updatedAt: new Date() }).where(eq(acceptanceCriteria.id, criterion.id))
        } else {
          await tx.insert(acceptanceCriteria).values({ taskId, position, text: criterion.text })
        }
      }
    }
    if (dependsOn) await setDependencies(tx, project, task, dependsOn)
    await tx.insert(auditLog).values({ projectId: project.id, taskId, actor, action: 'task.updated', detail: { changed: Object.keys(input) } })
  })
}

// Replaces a task's dependencies, keeping the graph a DAG (core)
async function setDependencies(tx: Executor, project: ProjectRow, task: TaskRow, numbers: number[]): Promise<void> {
  const wanted = [...new Set(numbers)]
  const found = wanted.length === 0
    ? []
    : await tx.select({ id: tasks.id, number: tasks.number }).from(tasks)
        .where(and(eq(tasks.projectId, project.id), inArray(tasks.number, wanted), isNull(tasks.deletedAt)))
  const unknown = wanted.filter(n => !found.some(d => d.number === n))
  if (unknown.length > 0) {
    throw new ApiFailure(400, { code: 'invalid_dependencies', problems: unknown.map(n => ({ code: 'unknown_dependency', dependsOn: taskRef(project.prefix, n) })) })
  }
  // The whole project graph with this task's new edges, checked by core
  const edges = await tx.select({ taskId: taskDependencies.taskId, dependsOnId: taskDependencies.dependsOnId }).from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId)).where(eq(tasks.projectId, project.id))
  const ids = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.projectId, project.id), isNull(tasks.deletedAt)))
  const graph = new Map<string, string[]>(ids.map(t => [t.id, []]))
  for (const edge of edges) {
    if (edge.taskId !== task.id) graph.get(edge.taskId)?.push(edge.dependsOnId)
  }
  graph.set(task.id, found.map(d => d.id))
  const problems = checkDependencies(graph)
  if (problems.length > 0) throw new ApiFailure(400, { code: 'invalid_dependencies', problems })
  await tx.delete(taskDependencies).where(eq(taskDependencies.taskId, task.id))
  if (found.length > 0) await tx.insert(taskDependencies).values(found.map(d => ({ taskId: task.id, dependsOnId: d.id })))
}

export async function addComment(db: Executor, taskId: string, input: { body: string, pinned: boolean }, author: Actor): Promise<Comment> {
  const [row] = await db.insert(comments).values({ taskId, author, body: input.body, pinned: input.pinned }).returning()
  return toComment(row!)
}

function toComment(row: typeof comments.$inferSelect): Comment {
  return { id: row.id, taskId: row.taskId, author: row.author, body: row.body, pinned: row.pinned, createdAt: row.createdAt.toISOString() }
}

export async function listComments(db: Executor, taskId: string): Promise<Comment[]> {
  const rows = await db.select().from(comments).where(eq(comments.taskId, taskId)).orderBy(asc(comments.createdAt))
  return rows.map(toComment)
}

export function toAuditEntry(row: typeof auditLog.$inferSelect): AuditEntry {
  return { id: row.id, projectId: row.projectId, taskId: row.taskId, actor: row.actor, action: row.action, detail: row.detail as Record<string, unknown>, createdAt: row.createdAt.toISOString() }
}

// PRD §14: every claim, transition, review and merge decision, readable per task
export async function listHistory(db: Executor, taskId: string): Promise<AuditEntry[]> {
  const rows = await db.select().from(auditLog).where(eq(auditLog.taskId, taskId)).orderBy(asc(auditLog.createdAt), asc(auditLog.id))
  return rows.map(toAuditEntry)
}

// D10 "Deleting": Backlog tasks go outright; the rest are hidden but kept
// with their history. Dependents move to Blocked unless the dependency was
// removed first. The caller has already stopped the run and closed the PR.
export async function deleteTaskRows(db: Executor, taskId: string, actor: Actor, reason: string | null): Promise<void> {
  await db.transaction(async (tx) => {
    const { task, project } = await lockTask(tx, taskId)
    const mode = deletionFor(task.status)
    if (mode === 'not_allowed') throw new ApiFailure(409, { code: 'conflict', constraint: 'merged_tasks_are_immutable' })
    const dependents = await tx.select({ task: tasks }).from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .where(and(eq(taskDependencies.dependsOnId, taskId), isNull(tasks.deletedAt)))
    for (const { task: dependent } of dependents) {
      const check = transition(toTaskState(dependent), { type: 'block', reason: DEPENDENCY_DELETED_REASON }, { kind: 'system', component: 'server' })
      if (!check.ok) continue // e.g. Backlog: nothing to block yet
      await applyTransition(tx, dependent, project, { type: 'block', reason: DEPENDENCY_DELETED_REASON }, { kind: 'system', component: 'server' }, { event: 'dependency_deleted', dependency: taskRef(project.prefix, task.number) })
    }
    await tx.insert(auditLog).values({ projectId: project.id, taskId, actor, action: 'task.deleted', detail: { mode, number: task.number, title: task.title, reason } })
    if (mode === 'hard') await tx.delete(tasks).where(eq(tasks.id, taskId))
    else await tx.update(tasks).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(tasks.id, taskId))
  })
}

// Adds the facts core needs to the human's request
async function humanEvent(db: Executor, task: TaskRow, input: HumanTransitionInput): Promise<TaskEvent> {
  if (input.type !== 'approve') return input
  const criteria = await db.select({ text: acceptanceCriteria.text }).from(acceptanceCriteria)
    .where(eq(acceptanceCriteria.taskId, task.id))
  return {
    type: 'approve',
    content: {
      title: task.title,
      description: richTextToPlainText(task.description),
      acceptanceCriteria: criteria.map(c => c.text)
    }
  }
}
