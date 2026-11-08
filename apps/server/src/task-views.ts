import type { Task, TaskAgent, TaskDesignPin, TaskSubmissionSummary } from '@corral/contracts'
import { authorRoleFor, isDesignPinStale, ROLES_TAKING_MESSAGES, taskRef, upgradePlainMarkdown } from '@corral/core'
import { schema, type Executor, type ProjectRow, type TaskRow } from '@corral/db'
import { and, asc, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { alias } from 'drizzle-orm/pg-core'
import { holdsAcrossEpics, holdsEpicOpen, parentHolds } from './delivery-sql.ts'
import { designPins } from './designs.ts'
import { notFound } from './errors.ts'
import { commitUrl } from './github-urls.ts'
import { parentFacts } from './parents.ts'
import { draftSessions } from './plan-items.ts'
import { toReview } from './runs.ts'
import { toTaskState } from './task-rows.ts'
import { CRITERIA_ORDER } from './criteria.ts'

// The API's view of tasks, built from their rows

const { acceptanceCriteria, agents, epicDependencies, epics, projects, reviews, runs, taskDependencies, taskSubmissions, tasks } = schema

type TaskView = 'board' | 'backlog' | 'all'

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
      .orderBy(...CRITERIA_ORDER),
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
      .where(and(inArray(runs.taskId, ids), inArray(runs.role, [...ROLES_TAKING_MESSAGES])))
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
  const agentOf = (taskId: string, role: typeof ROLES_TAKING_MESSAGES[number]): TaskAgent | null => {
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
      developer: agentOf(row.id, authorRoleFor(row.type)),
      reviewer: agentOf(row.id, 'reviewer')
    }
  })
}

type OmitFromUnion<T, K extends PropertyKey> = T extends unknown ? Omit<T, K> : never
type TaskWithoutAgents = OmitFromUnion<Task, 'developer' | 'reviewer' | 'waitingOnEpics' | 'parentTask' | 'rollup'>

function taskStatus(row: TaskRow, session: { id: string, title: string } | null) {
  const state = toTaskState(row)
  if (state.status === 'draft') return { status: state.status, statusReason: null, draftSession: session } as const
  if (state.reason !== null) return { status: state.status, statusReason: state.reason, draftSession: null } as const
  return { status: state.status, statusReason: null, draftSession: null } as const
}

function submissionSummary(project: ProjectRow, row: typeof taskSubmissions.$inferSelect | undefined): TaskSubmissionSummary | null {
  if (!row) return null
  const commit = (sha: string | null) => sha ? { sha, url: commitUrl(project.repository, sha) } : null
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
