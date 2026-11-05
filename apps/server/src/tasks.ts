import { appendAudit, auditEvent, type TransitionDetail } from './audit.ts'
import { holdsAcrossEpics, holdsEpicOpen, invalidateEpicReview, type InvalidatedEpics } from './epic-review-state.ts'
import type { AuditEntry, Comment, CreateTaskInput, HumanTransitionInput, PatchTaskInput, Task, TaskAgent, TaskDesignPin, TaskSubmissionSummary } from '@corral/contracts'
import { createTaskInput } from '@corral/contracts'
import {
  canChangeType,
  checkDependencies,
  checkEpicDependencies,
  createTask as createTaskState,
  DEPENDENCY_DELETED_REASON,
  deletionFor,
  isDesignPinStale,
  requiresHumanReview,
  richTextToMarkdown,
  richTextToPlainText,
  taskRef,
  normalizeTaskState,
  transition,
  upgradePlainMarkdown,
  type Actor,
  type TaskEvent,
  type TaskKind,
  type TaskState,
  type TaskStatus
} from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, desc, eq, inArray, isNull, max, ne, or, sql } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { ApiFailure, notFound } from './errors.ts'
import { ensureParent, parentFacts, parentHolds, refuseOnParent, syncDeliveryContent } from './parents.ts'
import { toReview } from './runs.ts'

const { acceptanceCriteria, agents, auditLog, comments, designVersions, epicDependencies, epics, planEpics, planSessions, planTasks, plans, projects, reviews, runs, taskDependencies, taskDesignPins, taskSubmissions, tasks } = schema

type TaskRow = typeof tasks.$inferSelect
type ProjectRow = typeof projects.$inferSelect

export type TaskView = 'board' | 'backlog' | 'all'
export type { ProjectRow, TaskRow }

export function toTaskState(row: TaskRow): TaskState {
  return normalizeTaskState({
    status: row.status,
    humanReview: row.humanReview,
    rebaseOnly: row.rebaseOnly,
    approvedHeadSha: row.approvedHeadSha,
    reviewRounds: row.reviewRounds,
    failedRuns: row.failedRuns,
    reason: row.statusReason,
    type: row.type
  })
}

// Builds API tasks for rows of one project, loading criteria and dependencies in bulk
export async function toTasks(db: Executor, project: ProjectRow, rows: TaskRow[]): Promise<Task[]> {
  if (rows.length === 0) return []
  const ids = rows.map(r => r.id)
  const leaseRunIds = rows.flatMap(r => r.leaseRunId ? [r.leaseRunId] : [])
  const epicIds = [...new Set(rows.flatMap(r => r.epicId ? [r.epicId] : []))]
  const drafts = rows.filter(r => r.status === 'draft').map(r => r.id)
  // A Merged dependency still holds its dependents until its epic is done (the
  // claim's rule). One that isn't Merged is its own, more exact, reason to wait.
  const dependency = alias(tasks, 'dependency')
  const parents = await parentFacts(db, project, rows)
  const [leasedRuns, criteriaRows, dependencies, waitingEpics, dependencyEpics, waitingParents, latestReviews, latestSubmissions, pinned, owners, runAgents] = await Promise.all([
    leaseRunIds.length > 0
      ? db.select({ id: runs.id, agentId: runs.agentId }).from(runs).where(inArray(runs.id, leaseRunIds))
      : [],
    db.select().from(acceptanceCriteria)
      .where(inArray(acceptanceCriteria.taskId, ids))
      .orderBy(asc(acceptanceCriteria.position)),
    db.select({ taskId: taskDependencies.taskId, number: tasks.number })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnId))
      .where(inArray(taskDependencies.taskId, ids))
      .orderBy(asc(tasks.number)),
    epicIds.length > 0
      ? db.selectDistinct({ epicId: epicDependencies.epicId, id: epics.id, title: epics.title })
          .from(epicDependencies)
          .innerJoin(epics, eq(epics.id, epicDependencies.dependsOnEpicId))
          .innerJoin(tasks, eq(tasks.epicId, epics.id))
          .where(and(inArray(epicDependencies.epicId, epicIds), eq(epics.projectId, project.id), holdsEpicOpen(tasks, epics)))
          .orderBy(asc(epics.title), asc(epics.id))
      : [],
    db.selectDistinct({ taskId: taskDependencies.taskId, id: epics.id, title: epics.title })
      .from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .innerJoin(dependency, eq(dependency.id, taskDependencies.dependsOnId))
      .innerJoin(epics, eq(epics.id, dependency.epicId))
      .where(and(inArray(taskDependencies.taskId, ids), eq(dependency.status, 'merged'), holdsAcrossEpics(dependency, epics, tasks.epicId)))
      .orderBy(asc(epics.title), asc(epics.id)),
    // A dependency on a parent waits for the parent's work to land
    db.selectDistinct({ taskId: taskDependencies.taskId, id: epics.id, title: epics.title })
      .from(taskDependencies)
      .innerJoin(dependency, eq(dependency.id, taskDependencies.dependsOnId))
      .innerJoin(epics, eq(epics.taskId, dependency.id))
      .where(and(inArray(taskDependencies.taskId, ids), parentHolds(db, dependency)))
      .orderBy(asc(epics.title), asc(epics.id)),
    db.selectDistinctOn([reviews.taskId]).from(reviews).where(inArray(reviews.taskId, ids)).orderBy(reviews.taskId, desc(reviews.createdAt)),
    db.selectDistinctOn([taskSubmissions.taskId]).from(taskSubmissions).where(inArray(taskSubmissions.taskId, ids)).orderBy(taskSubmissions.taskId, desc(taskSubmissions.sequence)),
    designPins(db, ids),
    draftSessions(db, drafts),
    // The latest run per task and role names its agent. Designs use their
    // designer in the API's Developer field (D23).
    db.selectDistinctOn([runs.taskId, runs.role], { taskId: runs.taskId, role: runs.role, id: agents.id, name: agents.name })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .where(and(inArray(runs.taskId, ids), inArray(runs.role, ['developer', 'designer', 'reviewer'])))
      .orderBy(runs.taskId, runs.role, desc(runs.queuedAt), desc(runs.number))
  ])
  const leaseAgents = new Map(leasedRuns.map(r => [r.id, r.agentId]))
  const criteria = Map.groupBy(criteriaRows, c => c.taskId)
  const dependenciesOf = Map.groupBy(dependencies, d => d.taskId)
  const epicWaits = Map.groupBy(waitingEpics, e => e.epicId)
  const dependencyWaits = Map.groupBy([...dependencyEpics, ...waitingParents], e => e.taskId)
  const waitingOn = (row: TaskRow) => [...new Map([
    ...(row.epicId ? epicWaits.get(row.epicId) ?? [] : []),
    ...dependencyWaits.get(row.id) ?? []
  ].map(({ id, title }) => [id, { id, title }])).values()].sort((a, b) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id))
  const reviewOf = new Map(latestReviews.map(r => [r.taskId, r]))
  const submissionOf = new Map(latestSubmissions.map(s => [s.taskId, s]))
  const pins = new Map(pinned.pins.map(p => [p.taskId, p]))
  const agentByRun = new Map(runAgents.map(r => [`${r.taskId}:${r.role}`, r]))
  const agentOf = (taskId: string, role: 'developer' | 'designer' | 'reviewer'): TaskAgent | null => {
    const found = agentByRun.get(`${taskId}:${role}`)
    return found ? { id: found.id, name: found.name } : null
  }

  return rows.map((row) => {
    const latest = reviewOf.get(row.id) ?? null
    // A verdict only describes the commit it was given for
    const current = latest && latest.headSha === row.headSha ? latest : null
    const pin = pins.get(row.id)
    const newest = pin ? pinned.latestApproved.get(pin.designTaskId) ?? null : null
    const stale = pin && isDesignPinStale({ version: pin.version, latestApproved: newest }, { status: row.status, started: pinned.started.has(row.id) })
    const design = pin ? { taskRef: taskRef(project.prefix, pin.number), version: pin.version, screens: pin.screens, newerVersion: stale ? newest : null } : null
    return {
      ...toTask(project, row, criteria.get(row.id) ?? [], dependenciesOf.get(row.id) ?? [], latest, current, design, owners.get(row.id) ?? null, row.leaseRunId ? leaseAgents.get(row.leaseRunId) ?? null : null, submissionSummary(project, submissionOf.get(row.id))),
      ...parents.delivery.get(row.id),
      parentTask: row.epicId ? parents.parents.get(row.epicId) ?? null : null,
      rollup: parents.rollups.get(row.id) ?? null,
      waitingOnEpics: waitingOn(row),
      developer: agentOf(row.id, row.type === 'design' ? 'designer' : 'developer'),
      reviewer: agentOf(row.id, 'reviewer')
    }
  })
}

// The tasks' design pins, with what decides whether each is stale (D20)
async function designPins(db: Executor, taskIds: string[]) {
  const pins = await db
    .select({ taskId: taskDesignPins.taskId, screens: taskDesignPins.screens, version: designVersions.version, designTaskId: designVersions.taskId, number: tasks.number })
    .from(taskDesignPins)
    .innerJoin(designVersions, eq(designVersions.id, taskDesignPins.designVersionId))
    .innerJoin(tasks, eq(tasks.id, designVersions.taskId))
    .where(inArray(taskDesignPins.taskId, taskIds))
  const { latestApproved, started } = await pinStaleness(db, pins.map(p => p.designTaskId), pins.map(p => p.taskId))
  return { pins, latestApproved, started }
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

type OmitFromUnion<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type TaskWithoutAgents = OmitFromUnion<Task, 'developer' | 'reviewer' | 'waitingOnEpics' | 'parentTask' | 'rollup'>

function taskStatus(row: TaskRow, session: { id: string, title: string } | null) {
  const state = toTaskState(row)
  if (state.status === 'draft') return { status: state.status, statusReason: null, draftSession: session } as const
  if (state.status === 'blocked' || state.status === 'failed') return { status: state.status, statusReason: state.reason, draftSession: null } as const
  return { status: state.status, statusReason: null, draftSession: null } as const
}

export const commitUrl = (project: ProjectRow, sha: string) => `https://github.com/${project.repository}/commit/${sha}`

function submissionSummary(project: ProjectRow, row: typeof taskSubmissions.$inferSelect | undefined): TaskSubmissionSummary | null {
  if (!row) return null
  const commit = (sha: string | null) => sha ? { sha, url: commitUrl(project, sha) } : null
  return {
    sequence: row.sequence,
    targetBranch: row.targetBranch,
    submitted: commit(row.submittedHeadSha)!,
    approved: commit(row.agentApprovedHeadSha),
    integrated: commit(row.integratedCommitSha),
    integratedAt: row.integratedAt?.toISOString() ?? null
  }
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
  leaseAgentId: string | null,
  submission: TaskSubmissionSummary | null
): TaskWithoutAgents {
  return {
    id: row.id,
    projectId: row.projectId,
    ref: taskRef(project.prefix, row.number),
    number: row.number,
    title: row.title,
    description: upgradePlainMarkdown(row.description),
    implementationPlan: row.implementationPlan ?? null,
    ...taskStatus(row, session),
    priority: row.priority,
    type: row.type,
    kind: row.kind,
    epicId: row.epicId,
    humanReview: row.humanReview,
    reviewRounds: row.reviewRounds,
    failedRuns: row.failedRuns,
    paused: row.paused,
    branch: row.branch,
    pr: row.prNumber !== null && row.prUrl !== null ? { number: row.prNumber, url: row.prUrl } : null,
    acceptanceCriteria: criteria
      .map(c => ({ id: c.id, position: c.position, text: c.text, checkedByHuman: c.checkedByHuman, met: c.checkedByHuman ? null : current?.criteria.find(v => v.criterionId === c.id)?.met ?? null })),
    dependsOn: dependencies.map(d => taskRef(project.prefix, d.number)),
    lease: row.leaseRunId && row.leaseRole && row.leaseExpiresAt && leaseAgentId
      ? { agentId: leaseAgentId, runId: row.leaseRunId, role: row.leaseRole, expiresAt: row.leaseExpiresAt.toISOString() }
      : null,
    headSha: row.headSha,
    latestReview: latest ? toReview(latest) : null,
    mergeCommitSha: row.mergeCommitSha,
    mergedAt: row.mergedAt?.toISOString() ?? null,
    submission,
    gateChecks: row.gateChecks,
    design,
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

// Like loadTask for many tasks at once, in the order given. A task that's gone
// is left out, so a publish loop has nothing to skip.
export async function loadTasks(db: Executor, taskIds: string[]): Promise<Task[]> {
  if (taskIds.length === 0) return []
  const found = await db.select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(inArray(tasks.id, taskIds), isNull(tasks.deletedAt)))
  const groups = [...Map.groupBy(found, f => f.project.id).values()]
  const loaded = await Promise.all(groups.map(group => toTasks(db, group[0]!.project, group.map(f => f.task))))
  const byId = new Map(loaded.flat().map(t => [t.id, t]))
  return taskIds.flatMap(id => byId.get(id) ?? [])
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
      view === 'board' ? ne(tasks.status, 'backlog') : view === 'backlog' ? inArray(tasks.status, ['backlog', 'parent']) : undefined
    ))
    .orderBy(asc(tasks.number))
  const listed = await toTasks(db, project, rows)
  // A parent is seen where its sub-tasks are: only Drafts keeps it in its plan,
  // and only Backlog keeps it off the Board
  return listed.filter((task) => {
    if (!task.rollup) return true
    if (task.rollup.drafting) return false
    if (view === 'board') return task.rollup.planned || task.rollup.total === 0
    if (view === 'backlog') return !task.rollup.planned
    return true
  })
}

// New tasks start in Backlog, or as Drafts for the PM's plans (D10).
// Returns the new task's ID.
export async function createTask(db: Executor, project: ProjectRow, rawInput: CreateTaskInput, actor: Actor, options: { draft?: boolean, epicFix?: boolean, kind?: TaskKind, keepEpicReview?: boolean, invalidatedEpics?: InvalidatedEpics } = {}): Promise<string> {
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
      if (!epic) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['epicId'], message: 'Unknown parent' }] })
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
    if (!['draft', 'backlog'].includes(state.status) && !options.keepEpicReview) {
      await invalidateEpicReview(tx, input.epicId, options.invalidatedEpics)
    }
    const [row] = await tx.insert(tasks).values({
      projectId: project.id,
      number: allocated!.number,
      title: input.title,
      description: input.description,
      implementationPlan: input.implementationPlan ?? null,
      type: input.type,
      kind: options.kind,
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
    if (input.epicId) await ensureParent(tx, input.epicId, actor)
    if (input.epicId && dependencies.length > 0) await checkParentCycles(tx, project)
    return taskId
  })
}

// Why a task can't gain sub-tasks, or null when it can (D31): nobody has
// started it, and nothing else depends on it staying a single task
export async function promotionRefusal(db: Executor, task: TaskRow): Promise<string | null> {
  if (task.epicId) return 'A sub-task can\'t have sub-tasks; they go one level deep. Add a separate follow-up task instead.'
  if (!['draft', 'backlog', 'ready'].includes(task.status) || task.leaseRunId) return `${task.status === 'merged' ? 'Merged' : 'Started'} work can't gain sub-tasks. Add a separate follow-up task instead.`
  if (task.type !== 'task' && task.type !== 'bug') return 'Only a task or a bug can gain sub-tasks.'
  const [run] = await db.select({ id: runs.id }).from(runs).where(eq(runs.taskId, task.id)).limit(1)
  const [submission] = await db.select({ id: taskSubmissions.id }).from(taskSubmissions).where(eq(taskSubmissions.taskId, task.id)).limit(1)
  if (run || submission || task.prNumber !== null) return 'This task has already had a run. Add a separate follow-up task instead.'
  const [pin] = await db.select({ taskId: taskDesignPins.taskId }).from(taskDesignPins).where(eq(taskDesignPins.taskId, task.id)).limit(1)
  if (pin) return 'A task pinned to a design can\'t gain sub-tasks.'
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

// Plan items and parents a human added, which a PM's revision never touches
export const HUMAN_PLAN_KEY = 'human-'

// A Draft belongs to its plan, so sub-tasks made from one stay Drafts in that
// plan: approving it adds them to the board and discarding it removes them.
// The plan's item for the Draft moves to `subId`, or `subId` joins as new.
async function joinDraftPlan(tx: Executor, epicId: string, subId: string, draftId: string): Promise<boolean> {
  const held = await tx.select({ planId: planTasks.planId, key: planTasks.key }).from(planTasks).innerJoin(plans, eq(plans.id, planTasks.planId))
    .where(and(eq(planTasks.taskId, draftId), eq(plans.status, 'proposed')))
  const [plan] = held
  if (!plan) return false
  if (draftId === subId) return true
  const [{ next } = { next: 0 }] = await tx.select({ next: sql<number>`coalesce(max(${planTasks.position}) + 1, 0)` }).from(planTasks).where(eq(planTasks.planId, plan.planId))
  await tx.insert(planTasks).values({ planId: plan.planId, taskId: subId, key: `${HUMAN_PLAN_KEY}${subId}`, change: 'added', position: next })
  const [known] = await tx.select({ key: planEpics.key }).from(planEpics).where(and(eq(planEpics.planId, plan.planId), eq(planEpics.epicId, epicId)))
  if (!known) {
    const [{ position } = { position: 0 }] = await tx.select({ position: sql<number>`coalesce(max(${planEpics.position}) + 1, 0)` }).from(planEpics).where(eq(planEpics.planId, plan.planId))
    await tx.insert(planEpics).values({ planId: plan.planId, key: `${HUMAN_PLAN_KEY}parent-${epicId}`, epicId, position })
  }
  return true
}

// Adds a sub-task, making a parent of the task if it isn't one yet
export async function addSubtask(db: Executor, project: ProjectRow, taskId: string, input: CreateTaskInput, actor: Actor): Promise<string> {
  return db.transaction(async (tx) => {
    const { task } = await lockTask(tx, taskId)
    if (task.status === 'parent') {
      const [delivery] = await tx.select().from(epics).where(eq(epics.taskId, taskId))
      if (delivery!.reviewState === 'merged' || delivery!.mergedAt) throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: 'This parent has delivered. Add a separate follow-up task instead.' }] })
      const live = await tx.select({ id: tasks.id, status: tasks.status }).from(tasks).where(and(eq(tasks.epicId, delivery!.id), isNull(tasks.deletedAt)))
      const subId = await createTask(tx, project, { ...input, epicId: delivery!.id }, actor)
      const drafted = live[0] && live.every(t => t.status === 'draft')
      if (drafted && await joinDraftPlan(tx, delivery!.id, subId, live[0]!.id)) await tx.update(tasks).set({ status: 'draft' }).where(eq(tasks.id, subId))
      return subId
    }
    const refusal = await promotionRefusal(tx, task)
    if (refusal) throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: refusal }] })
    const [claimed] = await tx.select({ id: epics.id }).from(epics).where(eq(epics.taskId, taskId))
    if (claimed) throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: 'A plan waiting for approval already turns this task into a parent.' }] })
    const [delivery] = await tx.insert(epics).values({
      projectId: project.id, taskId, title: task.title, description: richTextToMarkdown(task.description), priority: task.priority, reviewMode: project.epicReviewModeDefault, createdBy: actor
    }).returning({ id: epics.id })
    // Ready needs a description, and the work it describes moves to this sub-task
    const subId = await createTask(tx, project, { ...input, description: input.description ?? task.description as CreateTaskInput['description'], implementationPlan: input.implementationPlan ?? task.implementationPlan as CreateTaskInput['implementationPlan'], epicId: delivery!.id }, actor)
    await promoteToParent(tx, project, task, subId, actor)
    if (task.status === 'draft') {
      await tx.update(tasks).set({ status: 'draft' }).where(eq(tasks.id, subId))
      await tx.update(planTasks).set({ taskId: subId, key: `${HUMAN_PLAN_KEY}${subId}` }).where(and(eq(planTasks.taskId, taskId), inArray(planTasks.planId, tx.select({ id: plans.id }).from(plans).where(eq(plans.status, 'proposed')))))
      const [plan] = await tx.select({ planId: planTasks.planId }).from(planTasks).where(eq(planTasks.taskId, subId)).limit(1)
      if (plan) {
        const [{ position } = { position: 0 }] = await tx.select({ position: sql<number>`coalesce(max(${planEpics.position}) + 1, 0)` }).from(planEpics).where(eq(planEpics.planId, plan.planId))
        await tx.insert(planEpics).values({ planId: plan.planId, key: `${HUMAN_PLAN_KEY}parent-${delivery!.id}`, epicId: delivery!.id, position })
      } else await tx.update(tasks).set({ status: 'backlog' }).where(eq(tasks.id, subId))
    }
    if (task.status === 'ready') await transitionTask(tx, subId, { type: 'approve' }, actor)
    return subId
  })
}

// Applies a D10 transition the human asked for. The row is locked for the
// whole check-and-write, and core decides whether the transition is allowed.
// A pinned `comment` is the human's answer: it stands or falls with the
// transition, stamped with the transaction's time like the audit entry, which
// is how the Inbox finds it again.
export async function transitionTask(db: Executor, taskId: string, input: HumanTransitionInput, actor: Actor, options: { comment?: string | undefined, invalidatedEpics?: InvalidatedEpics } = {}): Promise<void> {
  await db.transaction(async (tx) => {
    const { task, project } = await lockTask(tx, taskId)
    await applyTransition(tx, task, project, await humanEvent(tx, task, input), actor, { event: input }, options.invalidatedEpics)
    if (options.comment) await tx.insert(comments).values({ taskId, author: actor, body: options.comment, pinned: true })
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
  detail: TransitionDetail,
  invalidatedEpics?: InvalidatedEpics
): Promise<TaskState> {
  const state = toTaskState(task)
  if (event.type === 'review_approved') {
    const humanCriteria = await tx.select({ id: acceptanceCriteria.id }).from(acceptanceCriteria)
      .where(and(eq(acceptanceCriteria.taskId, task.id), eq(acceptanceCriteria.checkedByHuman, true))).limit(1)
    if (humanCriteria.length) state.humanReview = true
  }
  // PR-free epic work integrates on agent approval. Its flag and human checks
  // become obligations of the epic's human approval (D27), and the row keeps them.
  if (task.integrationProtocol > 0) state.humanReview = false
  else if (task.epicId) {
    const [epic] = await tx.select({ reviewMode: epics.reviewMode }).from(epics).where(eq(epics.id, task.epicId))
    if (epic?.reviewMode === 'each_task') state.humanReview = true
  }
  const result = transition(state, event, actor, {
    reviewRoundCap: project.reviewRoundCap,
    failedRunCap: project.failedRunCap
  })
  if (!result.ok) throw new ApiFailure(409, { code: 'transition_rejected', reason: result.error })

  const next = result.task
  if (['draft', 'backlog'].includes(task.status) && !['draft', 'backlog'].includes(next.status)) {
    await invalidateEpicReview(tx, task.epicId, invalidatedEpics)
  }
  await tx.update(tasks).set({
    status: next.status,
    rebaseOnly: next.rebaseOnly ?? false,
    approvedHeadSha: next.approvedHeadSha ?? null,
    reviewRounds: next.reviewRounds,
    failedRuns: next.failedRuns,
    statusReason: next.reason,
    // A base update asked for in Ready to merge mustn't keep the approval
    // over whatever is pushed once the task has left it
    ...(next.status !== 'ready_to_merge' && { branchUpdateRequested: false }),
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
  fields?: string[]
  criteria: { added: number, removed: number, reworded: number } | null
}

// design/task.md: a PATCH per field. Criteria keep their IDs (and so their
// evidence and verdicts) when passed back with the same ID.
export async function patchTask(db: Executor, project: ProjectRow, taskId: string, input: PatchTaskInput, actor: Actor, invalidatedEpics?: InvalidatedEpics): Promise<TaskContentEdit | null> {
  return db.transaction(async (tx) => {
    // Serializes dependency edits, so concurrent patches can't each pass the
    // cycle check against the old graph. Taken before the task, the order
    // createTask needs. FOR UPDATE here would deadlock with any transaction
    // holding the task, as its audit insert takes KEY SHARE on the project.
    if (input.dependsOn) await tx.select({ id: projects.id }).from(projects).where(eq(projects.id, project.id)).for('no key update')
    const { task } = await lockTask(tx, taskId)
    // Merged is final (D10): the record stays as it shipped; comments still work
    if (task.status === 'merged') throw new ApiFailure(409, { code: 'conflict', constraint: 'task_merged' })
    if (task.status === 'parent') {
      if (input.acceptanceCriteria) refuseOnParent(task, 'criteria')
      if (input.dependsOn) refuseOnParent(task, 'dependencies')
      if (input.type !== undefined || input.epicId !== undefined || input.humanReview !== undefined) refuseOnParent(task, 'delivery')
    }
    if (input.type && !canChangeType(task, input.type)) throw new ApiFailure(409, { code: 'conflict', constraint: 'task_type_locked' })
    // D27: PM metadata edits must not remove the work that locks epic review mode.
    if (((actor.kind === 'agent' && actor.role === 'pm') || (actor.kind === 'human' && actor.viaPm)) && input.epicId !== undefined && input.epicId !== task.epicId && (task.prNumber !== null || task.integrationProtocol > 0)) {
      throw new ApiFailure(409, { code: 'conflict', constraint: 'task_epic_locked' })
    }
    const { acceptanceCriteria: criteriaInput, dependsOn, ...fields } = input
    // D20: a design task's flag can't be turned off, by the human or a plan
    if ((fields.type ?? task.type) === 'design') fields.humanReview = true
    if (fields.epicId) {
      const [epic] = await tx.select({ id: epics.id }).from(epics).where(and(eq(epics.id, fields.epicId), eq(epics.projectId, project.id)))
      if (!epic) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['epicId'], message: 'Unknown parent' }] })
    }
    // A selected task's submissions target this epic's branch and it can't take another path
    if (task.integrationProtocol > 0 && ((fields.epicId !== undefined && fields.epicId !== task.epicId) || (fields.type !== undefined && fields.type !== task.type))) {
      throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: 'A task submitting commits to its parent branch can\'t change parent or type' }] })
    }
    const descriptionChanged = fields.description !== undefined && JSON.stringify(fields.description) !== JSON.stringify(task.description)
    let criteriaChange: TaskContentEdit['criteria'] = null
    if (fields.epicId !== undefined && fields.epicId !== task.epicId && !['draft', 'backlog'].includes(task.status)) {
      for (const epicId of [task.epicId, fields.epicId]) {
        await invalidateEpicReview(tx, epicId, invalidatedEpics)
      }
    }
    if (Object.keys(fields).length > 0) {
      await tx.update(tasks).set({ ...fields, updatedAt: new Date() }).where(eq(tasks.id, taskId))
    }
    if (task.status === 'parent') await syncDeliveryContent(tx, taskId, fields)
    if (fields.epicId) {
      await ensureParent(tx, fields.epicId, actor)
      await checkParentCycles(tx, project)
    }
    let newHumanCheck = false
    let newAgentCheck = false
    if (criteriaInput) {
      const existing = await tx.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, taskId))
      newHumanCheck = criteriaInput.some(c => c.checkedByHuman && !existing.some(e => e.id === c.id && e.checkedByHuman))
      newAgentCheck = criteriaInput.some((c) => {
        const held = existing.find(e => e.id === c.id)
        return !(c.checkedByHuman ?? held?.checkedByHuman ?? false) && (!held || held.checkedByHuman)
      })
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
    if (task.status === 'ready_to_merge' && newAgentCheck && actor.kind === 'human') {
      // Evidence for it can only come from a developer run (D21, flows.md step
      // 5), so this is the human asking for more work, whatever else changed.
      // Without it the merge gate would wait for evidence nothing will produce.
      await applyTransition(tx, task, project, { type: 'human_request_changes' }, actor, { event: { type: 'human_request_changes' } })
      await addComment(tx, taskId, { body: `A criterion that needs evidence was added after approval. Attach evidence for it, then report ${task.integrationProtocol > 0 ? 'commit_submitted' : 'pr_updated'}.`, pinned: true }, { kind: 'system', component: 'server' })
    // A PR-free task's new check goes to the epic review instead
    } else if (task.status === 'ready_to_merge' && newHumanCheck && task.integrationProtocol === 0) {
      await applyTransition(tx, task, project, { type: 'require_human_check' }, { kind: 'system', component: 'server' }, { event: 'require_human_check' })
    }
    if (dependsOn) await setDependencies(tx, project, task, dependsOn)
    // An empty input still ran the merged guard above, but it edited nothing
    if (Object.keys(input).length > 0) await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('task.updated', { changed: Object.keys(input) }))
    const changedFields = Object.keys(fields).filter(k => JSON.stringify(fields[k as keyof typeof fields]) !== JSON.stringify(task[k as keyof TaskRow]))
    if (dependsOn !== undefined) changedFields.push('dependsOn')
    return descriptionChanged || criteriaChange || changedFields.length ? { description: descriptionChanged, criteria: criteriaChange, fields: changedFields.filter(k => k !== 'description') } : null
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
  await checkParentCycles(tx, project, new Map([[task.id, found.map(d => d.id)]]))
  await tx.delete(taskDependencies).where(and(eq(taskDependencies.projectId, project.id), eq(taskDependencies.taskId, task.id)))
  if (found.length > 0) await tx.insert(taskDependencies).values(found.map(d => ({ projectId: project.id, taskId: task.id, dependsOnId: d.id })))
}

// A cycle can run through a parent, which waits on its sub-tasks and its
// delivery record: task edges, parent edges and sub-tasks are one graph (D31).
// `changed` holds edges this write is about to replace.
export async function checkParentCycles(tx: Executor, project: ProjectRow, changed: ReadonlyMap<string, readonly string[]> = new Map(), promoting: ReadonlySet<string> = new Set()): Promise<void> {
  const rows = await tx.select({ id: tasks.id, epicId: tasks.epicId, status: tasks.status, type: tasks.type, parentOf: epics.id }).from(tasks)
    .leftJoin(epics, and(eq(epics.taskId, tasks.id), or(eq(tasks.status, 'parent'), inArray(tasks.id, [...promoting, '00000000-0000-0000-0000-000000000000']))))
    .where(and(eq(tasks.projectId, project.id), isNull(tasks.deletedAt)))
  const edges = await tx.select({ taskId: taskDependencies.taskId, dependsOnId: taskDependencies.dependsOnId }).from(taskDependencies).where(eq(taskDependencies.projectId, project.id))
  const parentEdges = await tx.select().from(epicDependencies).where(eq(epicDependencies.projectId, project.id))
  const projectEpics = await tx.select({ id: epics.id, title: epics.title }).from(epics).where(eq(epics.projectId, project.id))
  const dependsOn = Map.groupBy(edges, e => e.taskId)
  const problems = checkEpicDependencies(
    new Map(projectEpics.map(e => [e.id, parentEdges.filter(d => d.epicId === e.id).map(d => d.dependsOnEpicId)])),
    rows.map(t => ({ ...t, dependsOn: changed.get(t.id) ?? (dependsOn.get(t.id) ?? []).map(e => e.dependsOnId) })),
    new Map(projectEpics.map(e => [e.id, e.title]))
  )
  if (problems.length > 0) throw new ApiFailure(400, { code: 'invalid_input', issues: problems.map(p => ({ message: `Dependency cycle: ${p.epics.join(' → ') || 'a task waits on its own parent'}` })) })
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

// Each task's comments, oldest first
export async function listCommentsFor(db: Executor, taskIds: string[]): Promise<Map<string, Comment[]>> {
  if (taskIds.length === 0) return new Map()
  const rows = await db.select().from(comments).where(inArray(comments.taskId, taskIds)).orderBy(asc(comments.createdAt), asc(comments.id))
  return Map.groupBy(rows.map(toComment), c => c.taskId)
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
    let mode = options.soft && task.status === 'draft' ? 'soft' : deletionFor(task)
    if (mode === 'not_allowed') throw new ApiFailure(409, { code: 'conflict', constraint: 'merged_tasks_are_immutable' })
    const [delivery] = task.status === 'parent' ? await tx.select().from(epics).where(eq(epics.taskId, taskId)).for('update') : []
    if (delivery) {
      // A parent goes once it has nothing left: its sub-tasks are deleted first
      const [sub] = await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.epicId, delivery.id), isNull(tasks.deletedAt))).limit(1)
      if (sub) throw new ApiFailure(409, { code: 'conflict', constraint: 'parent_has_subtasks' })
      if (delivery.reviewState === 'merged') throw new ApiFailure(409, { code: 'conflict', constraint: 'parent_delivered' })
      if (delivery.branch) throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: `${delivery.branch} isn't merged, so deleting this parent would lose its work. Close its PR and delete the branch first.` }] })
      // Comments and history stay with the record
      const [comment] = await tx.select({ id: comments.id }).from(comments).where(eq(comments.taskId, taskId)).limit(1)
      const [history] = await tx.select({ id: auditLog.id }).from(auditLog).where(and(eq(auditLog.taskId, taskId), ne(auditLog.action, 'task.created'))).limit(1)
      if (comment || history) mode = 'soft'
    }
    // A soft-deleted sub-task that submitted commits keeps its epicId (tasks_integration_protocol)
    const [kept] = delivery ? await tx.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.epicId, delivery.id), sql`${tasks.integrationProtocol} > 0`)).limit(1) : []
    const dependentRows = tx.select({ task: tasks }).from(taskDependencies)
      .innerJoin(tasks, eq(tasks.id, taskDependencies.taskId))
      .where(and(eq(taskDependencies.dependsOnId, taskId), isNull(tasks.deletedAt)))
      .orderBy(asc(tasks.id))
    // Blocking writes each dependent from this read, so it must be locked
    const dependents = await (options.detachDependents ? dependentRows : dependentRows.for('update', { of: tasks }))
    if (options.detachDependents) await tx.delete(taskDependencies).where(eq(taskDependencies.dependsOnId, taskId))
    else for (const { task: dependent } of dependents) {
      const check = transition(toTaskState(dependent), { type: 'block', reason: DEPENDENCY_DELETED_REASON }, { kind: 'system', component: 'server' })
      if (!check.ok) continue // e.g. Backlog: nothing to block yet
      await applyTransition(tx, dependent, project, { type: 'block', reason: DEPENDENCY_DELETED_REASON }, { kind: 'system', component: 'server' }, { event: 'dependency_deleted', dependency: taskRef(project.prefix, task.number) })
    }
    await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('task.deleted', { mode, number: task.number, title: task.title, reason }))
    if (delivery && kept) await tx.update(epics).set({ taskId: null }).where(eq(epics.id, delivery.id))
    else if (delivery) await tx.delete(epics).where(eq(epics.id, delivery.id))
    if (mode === 'hard') await tx.delete(tasks).where(eq(tasks.id, taskId))
    // No run keeps a lease on a hidden task: it would pass every fence
    else await tx.update(tasks).set({ deletedAt: new Date(), updatedAt: new Date(), leaseRunId: null, leaseRole: null, leaseExpiresAt: null, leaseHeartbeatAt: null }).where(eq(tasks.id, taskId))
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
