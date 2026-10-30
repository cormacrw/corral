import { appendAudit, auditEvent, type TransitionDetail } from './audit.ts'
import { holdsEpicOpen, invalidateEpicReview } from './epic-review-state.ts'
import type { AuditEntry, Comment, CreateTaskInput, HumanTransitionInput, PatchTaskInput, Task, TaskAgent, TaskDesignPin } from '@corral/contracts'
import { createTaskInput } from '@corral/contracts'
import {
  canChangeTaskType,
  checkDependencies,
  createTask as createTaskState,
  DEPENDENCY_DELETED_REASON,
  deletionFor,
  isDesignPinStale,
  requiresHumanReview,
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
import { and, asc, desc, eq, inArray, isNull, max, ne, sql } from 'drizzle-orm'
import { ApiFailure, notFound } from './errors.ts'
import { toReview } from './runs.ts'

const { acceptanceCriteria, agents, auditLog, comments, designVersions, epicDependencies, epics, planSessions, planTasks, plans, projects, reviews, runs, taskDependencies, taskDesignPins, tasks } = schema

type TaskRow = typeof tasks.$inferSelect
type ProjectRow = typeof projects.$inferSelect

export type TaskView = 'board' | 'backlog' | 'all'
export type { ProjectRow, TaskRow }

export function toTaskState(row: TaskRow): TaskState {
  return {
    status: row.status,
    humanReview: row.humanReview,
    rebaseOnly: row.rebaseOnly,
    approvedHeadSha: row.approvedHeadSha,
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
  const leaseRunIds = rows.flatMap(r => r.leaseRunId ? [r.leaseRunId] : [])
  const leasedRuns = leaseRunIds.length > 0
    ? await db.select({ id: runs.id, agentId: runs.agentId }).from(runs).where(inArray(runs.id, leaseRunIds))
    : []
  const leaseAgents = new Map(leasedRuns.map(r => [r.id, r.agentId]))
  const criteria = await db.select().from(acceptanceCriteria)
    .where(inArray(acceptanceCriteria.taskId, ids))
    .orderBy(asc(acceptanceCriteria.position))
  const dependencies = await db
    .select({ taskId: taskDependencies.taskId, number: tasks.number })
    .from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnId))
    .where(inArray(taskDependencies.taskId, ids))
    .orderBy(asc(tasks.number))
  const waitingEpics = await db.selectDistinct({ epicId: epicDependencies.epicId, id: epics.id, title: epics.title })
    .from(epicDependencies)
    .innerJoin(epics, eq(epics.id, epicDependencies.dependsOnEpicId))
    .innerJoin(tasks, eq(tasks.epicId, epics.id))
    .where(and(eq(epics.projectId, project.id), holdsEpicOpen(tasks, epics)))
    .orderBy(asc(epics.title), asc(epics.id))
  // Newest first, so the first row per task is its latest review
  const reviewRows = await db.select().from(reviews).where(inArray(reviews.taskId, ids)).orderBy(desc(reviews.createdAt))
  const pins = await db
    .select({ taskId: taskDesignPins.taskId, screens: taskDesignPins.screens, version: designVersions.version, designTaskId: designVersions.taskId, number: tasks.number })
    .from(taskDesignPins)
    .innerJoin(designVersions, eq(designVersions.id, taskDesignPins.designVersionId))
    .innerJoin(tasks, eq(tasks.id, designVersions.taskId))
    .where(inArray(taskDesignPins.taskId, ids))
  const { latestApproved, started } = await pinStaleness(db, pins.map(p => p.designTaskId), ids)
  const owners = await draftSessions(db, rows.filter(r => r.status === 'draft').map(r => r.id))
  // Newest first, so the first run per task and role names its agent.
  // Designs use their designer in the API's Developer field (D23).
  const runAgents = await db
    .select({ taskId: runs.taskId, role: runs.role, id: agents.id, name: agents.name })
    .from(runs)
    .innerJoin(agents, eq(agents.id, runs.agentId))
    .where(and(inArray(runs.taskId, ids), inArray(runs.role, ['developer', 'designer', 'reviewer'])))
    .orderBy(desc(runs.queuedAt), desc(runs.number))
  const agentOf = (taskId: string, role: 'developer' | 'designer' | 'reviewer'): TaskAgent | null => {
    const found = runAgents.find(r => r.taskId === taskId && r.role === role)
    return found ? { id: found.id, name: found.name } : null
  }

  return rows.map((row) => {
    const latest = reviewRows.find(r => r.taskId === row.id) ?? null
    // A verdict only describes the commit it was given for
    const current = latest && latest.headSha === row.headSha ? latest : null
    const pin = pins.find(p => p.taskId === row.id)
    const newest = pin ? latestApproved.get(pin.designTaskId) ?? null : null
    const stale = pin && isDesignPinStale({ version: pin.version, latestApproved: newest }, { status: row.status, started: started.has(row.id) })
    const design = pin ? { taskRef: taskRef(project.prefix, pin.number), version: pin.version, screens: pin.screens, newerVersion: stale ? newest : null } : null
    return {
      ...toTask(project, row, criteria, dependencies, latest, current, design, owners.get(row.id) ?? null, row.leaseRunId ? leaseAgents.get(row.leaseRunId) ?? null : null),
      waitingOnEpics: waitingEpics.filter(e => e.epicId === row.epicId).map(({ id, title }) => ({ id, title })),
      developer: agentOf(row.id, row.type === 'design' ? 'designer' : 'developer'),
      reviewer: agentOf(row.id, 'reviewer')
    }
  })
}

// The Plan session each Draft belongs to: the session of the latest proposed
// plan version that includes it, so a plan in another session that revises
// it by ref takes it over. A Draft no proposed plan includes falls back to
// the latest plan that does, so it's never orphaned.
export async function draftSessions(db: Executor, taskIds: string[]): Promise<Map<string, { id: string, title: string }>> {
  const owners = new Map<string, { id: string, title: string }>()
  if (taskIds.length === 0) return owners
  const rows = await db.select({ taskId: planTasks.taskId, id: planSessions.id, title: planSessions.title })
    .from(planTasks)
    .innerJoin(plans, eq(plans.id, planTasks.planId))
    .innerJoin(planSessions, eq(planSessions.id, plans.sessionId))
    .where(and(inArray(planTasks.taskId, taskIds), ne(planTasks.change, 'removed')))
    .orderBy(desc(sql`${plans.status} = 'proposed'`), desc(plans.createdAt), desc(plans.version))
  for (const row of rows) {
    if (row.taskId && !owners.has(row.taskId)) owners.set(row.taskId, { id: row.id, title: row.title })
  }
  return owners
}

function toTask(
  project: ProjectRow,
  row: TaskRow,
  criteria: (typeof acceptanceCriteria.$inferSelect)[],
  dependencies: { taskId: string, number: number }[],
  latest: typeof reviews.$inferSelect | null,
  current: typeof reviews.$inferSelect | null,
  design: TaskDesignPin | null,
  session: { id: string, title: string } | null,
  leaseAgentId: string | null
): Omit<Task, 'developer' | 'reviewer' | 'waitingOnEpics'> {
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
      .map(c => ({ id: c.id, position: c.position, text: c.text, checkedByHuman: c.checkedByHuman, met: c.checkedByHuman ? null : current?.criteria.find(v => v.criterionId === c.id)?.met ?? null })),
    dependsOn: dependencies.filter(d => d.taskId === row.id).map(d => taskRef(project.prefix, d.number)),
    lease: row.leaseRunId && row.leaseRole && row.leaseExpiresAt && leaseAgentId
      ? { agentId: leaseAgentId, runId: row.leaseRunId, role: row.leaseRole, expiresAt: row.leaseExpiresAt.toISOString() }
      : null,
    headSha: row.headSha,
    latestReview: latest ? toReview(latest) : null,
    mergeCommitSha: row.mergeCommitSha,
    mergedAt: row.mergedAt?.toISOString() ?? null,
    gateChecks: row.gateChecks,
    design,
    planSessionId: row.status === 'draft' ? session?.id ?? null : null,
    planSessionTitle: row.status === 'draft' ? session?.title ?? null : null,
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

// What decides whether pins are stale (D20): each design's latest approved
// version, and which of the tasks have had a run
export async function pinStaleness(db: Executor, designTaskIds: string[], taskIds: string[]): Promise<{ latestApproved: Map<string, number>, started: Set<string> }> {
  const latestApproved = new Map<string, number>()
  const started = new Set<string>()
  if (designTaskIds.length === 0) return { latestApproved, started }
  const approved = await db.select({ taskId: designVersions.taskId, version: max(designVersions.version) }).from(designVersions)
    .where(and(inArray(designVersions.taskId, [...new Set(designTaskIds)]), eq(designVersions.status, 'approved'))).groupBy(designVersions.taskId)
  for (const a of approved) if (a.version !== null) latestApproved.set(a.taskId, a.version)
  const ran = await db.selectDistinct({ taskId: runs.taskId }).from(runs).where(inArray(runs.taskId, taskIds))
  for (const r of ran) if (r.taskId) started.add(r.taskId)
  return { latestApproved, started }
}

// Pins a build task to a design version and its screens (D20), or unpins it
export async function setDesignPin(db: Executor, taskId: string, pin: { designVersionId: string, screens: string[] } | null): Promise<void> {
  if (!pin) {
    await db.delete(taskDesignPins).where(eq(taskDesignPins.taskId, taskId))
    return
  }
  await db.insert(taskDesignPins).values({ taskId, ...pin })
    .onConflictDoUpdate({ target: taskDesignPins.taskId, set: { ...pin, updatedAt: new Date() } })
}

export class TaskNotFound extends Error {}

export async function findTaskId(db: Executor, projectId: string, number: number): Promise<string> {
  const [row] = await db.select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.number, number), isNull(tasks.deletedAt)))
  if (!row) throw notFound()
  return row.id
}

// An agent's task ref, from its project only. The message goes to the agent.
export async function findTaskByRef(db: Executor, project: Pick<ProjectRow, 'id' | 'prefix'>, ref: string): Promise<TaskRow> {
  const match = new RegExp(`^${project.prefix}-(\\d+)$`, 'i').exec(ref.trim())
  if (!match) throw new TaskNotFound(`No task ${ref} in this project (refs look like ${project.prefix}-12)`)
  const [task] = await db.select().from(tasks)
    .where(and(eq(tasks.projectId, project.id), eq(tasks.number, Number(match[1])), isNull(tasks.deletedAt)))
  if (!task) throw new TaskNotFound(`No task ${ref} in this project`)
  return task
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
export async function createTask(db: Executor, project: ProjectRow, rawInput: CreateTaskInput, actor: Actor, options: { draft?: boolean, epicFix?: boolean } = {}): Promise<string> {
  const input = createTaskInput.parse(rawInput)
  // D27 integration feedback creates Ready work without a separate plan approval.
  const created: ReturnType<typeof createTaskState> = options.epicFix
    ? { ok: true, task: { type: input.type, status: 'ready', humanReview: input.humanReview ?? project.humanReviewDefault, reviewRounds: 0, failedRuns: 0, reason: null } }
    : createTaskState(actor, requiresHumanReview(input.type, input.humanReview ?? project.humanReviewDefault), options.draft, input.type)
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
    if (!['draft', 'backlog'].includes(state.status)) await invalidateEpicReview(tx, input.epicId)
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
        input.acceptanceCriteria.map((criterion, position) => ({ taskId, position, ...(typeof criterion === 'string' ? { text: criterion } : criterion) }))
      )
    }
    if (dependencies.length > 0) {
      await tx.insert(taskDependencies).values(dependencies.map(d => ({ projectId: project.id, taskId, dependsOnId: d.id })))
    }
    await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('task.created', { number: row!.number }))
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
  detail: TransitionDetail
): Promise<TaskState> {
  const state = toTaskState(task)
  if (event.type === 'review_approved') {
    const humanCriteria = await tx.select({ id: acceptanceCriteria.id }).from(acceptanceCriteria)
      .where(and(eq(acceptanceCriteria.taskId, task.id), eq(acceptanceCriteria.checkedByHuman, true))).limit(1)
    if (humanCriteria.length) state.humanReview = true
  }
  if (task.epicId) {
    const [epic] = await tx.select({ reviewMode: epics.reviewMode }).from(epics).where(eq(epics.id, task.epicId))
    if (epic?.reviewMode === 'each_task') state.humanReview = true
  }
  const result = transition(state, event, actor, {
    reviewRoundCap: project.reviewRoundCap,
    failedRunCap: project.failedRunCap
  })
  if (!result.ok) throw new ApiFailure(409, { code: 'transition_rejected', reason: result.error })

  const next = result.task
  if (['draft', 'backlog'].includes(task.status) && !['draft', 'backlog'].includes(next.status)) await invalidateEpicReview(tx, task.epicId)
  await tx.update(tasks).set({
    status: next.status,
    rebaseOnly: next.rebaseOnly ?? false,
    approvedHeadSha: next.approvedHeadSha ?? null,
    reviewRounds: next.reviewRounds,
    failedRuns: next.failedRuns,
    statusReason: next.reason,
    // A spike finishes without a merge (D19); this is when it finished
    ...(task.type === 'spike' && next.status === 'merged' && task.status !== 'merged' && { mergedAt: new Date() }),
    updatedAt: new Date()
  }).where(eq(tasks.id, task.id))
  // D20: a design version sent back, by the reviewer or the human, is kept
  // unchanged except for its status; the next submission is a new version
  if (task.type === 'design' && (event.type === 'changes_requested' || event.type === 'human_request_changes')) {
    const [latest] = await tx.select({ id: designVersions.id }).from(designVersions)
      .where(and(eq(designVersions.taskId, task.id), eq(designVersions.status, 'submitted'))).orderBy(desc(designVersions.version)).limit(1)
    if (latest) {
      await tx.update(designVersions).set({ status: 'changes_requested', ...(event.type === 'human_request_changes' && event.feedback && { feedback: event.feedback }), updatedAt: new Date() })
        .where(eq(designVersions.id, latest.id))
    }
  }
  if (event.type === 'human_request_changes' && event.feedback?.trim()) {
    await tx.insert(comments).values({ taskId: task.id, author: actor, body: event.feedback!, pinned: true })
  }
  await appendAudit(tx, { projectId: project.id, taskId: task.id, actor }, auditEvent('task.transition', { ...detail, from: task.status, to: next.status satisfies TaskStatus }))
  return next
}

// What a PATCH changed in the text an agent works to (PRD §7.3), or null
// when the description and criteria are as they were
export interface TaskContentEdit {
  description: boolean
  criteria: { added: number, removed: number, reworded: number } | null
}

// design/task.md: a PATCH per field. Criteria keep their IDs (and so their
// evidence and verdicts) when passed back with the same ID.
export async function patchTask(db: Executor, project: ProjectRow, taskId: string, input: PatchTaskInput, actor: Actor): Promise<TaskContentEdit | null> {
  return db.transaction(async (tx) => {
    const { task } = await lockTask(tx, taskId)
    // Merged is final (D10): the record stays as it shipped; comments still work
    if (task.status === 'merged') throw new ApiFailure(409, { code: 'conflict', constraint: 'task_merged' })
    if (input.type && input.type !== task.type && !canChangeTaskType(task)) {
      throw new ApiFailure(409, { code: 'conflict', constraint: 'task_type_locked' })
    }
    const { acceptanceCriteria: criteriaInput, dependsOn, ...fields } = input
    // D20: a design task's flag can't be turned off, by the human or a plan
    if ((fields.type ?? task.type) === 'design') fields.humanReview = true
    if (fields.epicId) {
      const [epic] = await tx.select({ id: epics.id }).from(epics).where(and(eq(epics.id, fields.epicId), eq(epics.projectId, project.id)))
      if (!epic) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['epicId'], message: 'Unknown epic' }] })
    }
    const descriptionChanged = fields.description !== undefined && JSON.stringify(fields.description) !== JSON.stringify(task.description)
    let criteriaChange: TaskContentEdit['criteria'] = null
    if (fields.epicId !== undefined && fields.epicId !== task.epicId && !['draft', 'backlog'].includes(task.status)) {
      await invalidateEpicReview(tx, task.epicId)
      await invalidateEpicReview(tx, fields.epicId)
    }
    if (Object.keys(fields).length > 0) {
      await tx.update(tasks).set({ ...fields, updatedAt: new Date() }).where(eq(tasks.id, taskId))
    }
    let newHumanCheck = false
    if (criteriaInput) {
      const existing = await tx.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, taskId))
      newHumanCheck = criteriaInput.some(c => c.checkedByHuman && !existing.some(e => e.id === c.id && e.checkedByHuman))
      const keep = new Set(criteriaInput.map(c => c.id).filter((id): id is string => Boolean(id)))
      const gone = existing.filter(c => !keep.has(c.id)).map(c => c.id)
      if (gone.length > 0) await tx.delete(acceptanceCriteria).where(inArray(acceptanceCriteria.id, gone))
      const added = criteriaInput.filter(c => !c.id || !existing.some(e => e.id === c.id)).length
      const reworded = criteriaInput.filter(c => existing.some(e => e.id === c.id && (e.text !== c.text || e.checkedByHuman !== (c.checkedByHuman ?? e.checkedByHuman)))).length
      const reordered = criteriaInput.some((c, i) => c.id !== undefined && existing.find(e => e.id === c.id)?.position !== i)
      if (added + gone.length + reworded > 0 || reordered) criteriaChange = { added, removed: gone.length, reworded }
      for (const [position, criterion] of criteriaInput.entries()) {
        if (criterion.id && existing.some(c => c.id === criterion.id)) {
          await tx.update(acceptanceCriteria).set({ position, text: criterion.text, checkedByHuman: criterion.checkedByHuman, updatedAt: new Date() }).where(eq(acceptanceCriteria.id, criterion.id))
        } else {
          await tx.insert(acceptanceCriteria).values({ taskId, position, text: criterion.text, checkedByHuman: criterion.checkedByHuman })
        }
      }
    }
    if (task.status === 'ready_to_merge' && newHumanCheck) {
      await applyTransition(tx, task, project, { type: 'require_human_check' }, { kind: 'system', component: 'server' }, { event: 'require_human_check' })
    }
    if (dependsOn) await setDependencies(tx, project, task, dependsOn)
    await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('task.updated', { changed: Object.keys(input) }))
    return descriptionChanged || criteriaChange ? { description: descriptionChanged, criteria: criteriaChange } : null
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
  await tx.delete(taskDependencies).where(and(eq(taskDependencies.projectId, project.id), eq(taskDependencies.taskId, task.id)))
  if (found.length > 0) await tx.insert(taskDependencies).values(found.map(d => ({ projectId: project.id, taskId: task.id, dependsOnId: d.id })))
}

// Stamped with the clock, not the transaction's start, so comments posted in
// one transaction list in the order they were added
export async function addComment(db: Executor, taskId: string, input: { body: string, pinned: boolean }, author: Actor): Promise<Comment> {
  const [row] = await db.insert(comments).values({ taskId, author, body: input.body, pinned: input.pinned, createdAt: sql`clock_timestamp()` }).returning()
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
// `detachDependents` drops the dependents' edges instead, for drafts that
// were never accepted work, so accepted tasks keep their status (COR-119).
export async function deleteTaskRows(db: Executor, taskId: string, actor: Actor, reason: string | null, options: { soft?: boolean, detachDependents?: boolean } = {}): Promise<string[]> {
  return db.transaction(async (tx) => {
    const { task, project } = await lockTask(tx, taskId)
    const mode = options.soft && task.status === 'draft' ? 'soft' : deletionFor(task)
    if (mode === 'not_allowed') throw new ApiFailure(409, { code: 'conflict', constraint: 'merged_tasks_are_immutable' })
    const dependents = await tx.select({ task: tasks }).from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .where(and(eq(taskDependencies.dependsOnId, taskId), isNull(tasks.deletedAt)))
    if (options.detachDependents) await tx.delete(taskDependencies).where(eq(taskDependencies.dependsOnId, taskId))
    else for (const { task: dependent } of dependents) {
      const check = transition(toTaskState(dependent), { type: 'block', reason: DEPENDENCY_DELETED_REASON }, { kind: 'system', component: 'server' })
      if (!check.ok) continue // e.g. Backlog: nothing to block yet
      await applyTransition(tx, dependent, project, { type: 'block', reason: DEPENDENCY_DELETED_REASON }, { kind: 'system', component: 'server' }, { event: 'dependency_deleted', dependency: taskRef(project.prefix, task.number) })
    }
    await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('task.deleted', { mode, number: task.number, title: task.title, reason }))
    if (mode === 'hard') await tx.delete(tasks).where(eq(tasks.id, taskId))
    else await tx.update(tasks).set({ deletedAt: new Date(), updatedAt: new Date() }).where(eq(tasks.id, taskId))
    return dependents.map(d => d.task.id)
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
