import type { Epic, EpicDetail, EpicSync, PatchEpicInput } from '@corral/contracts'
import { checkEpicDependencies, isTaskDone, taskRef, type CompletionState, type Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, eq, inArray, or } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { openDecision } from './epic-rebase-approval.ts'
import { ApiFailure, notFound } from './errors.ts'
import { toTasks, type ProjectRow } from './tasks.ts'

const { epics, epicDependencies, taskDependencies, taskIntegrationOperations, projects, tasks } = schema

type EpicRow = typeof epics.$inferSelect

// Epics group a plan's tasks (D9). Counts leave out Drafts and Backlog tasks, which aren't on
// the board yet; the detail includes them so the canvas shows the whole plan.
export async function listEpics(db: Executor, project: ProjectRow): Promise<Epic[]> {
  const rows = await db.select().from(epics).where(eq(epics.projectId, project.id)).orderBy(asc(epics.createdAt))
  const taskRows = await db.select({ epicId: tasks.epicId, status: tasks.status, type: tasks.type, prNumber: tasks.prNumber, integrationProtocol: tasks.integrationProtocol, deletedAt: tasks.deletedAt }).from(tasks)
    .where(eq(tasks.projectId, project.id))
  const edges = await db.select().from(epicDependencies)
  const syncs = await epicSyncs(db, project, rows)
  return rows.map(row => toEpic(row, project, taskRows.filter(t => t.epicId === row.id), edges, syncs.get(row.id) ?? null))
}

export async function getEpic(db: Executor, epicId: string): Promise<EpicDetail> {
  const { row, project } = await findEpic(db, epicId)
  const taskRows = await db.select().from(tasks).where(eq(tasks.epicId, epicId)).orderBy(asc(tasks.number))
  const edges = await db.select().from(epicDependencies)
    .where(or(eq(epicDependencies.epicId, epicId), eq(epicDependencies.dependsOnEpicId, epicId)))
  const syncs = await epicSyncs(db, project, [row])
  return { ...toEpic(row, project, taskRows, edges, syncs.get(row.id) ?? null), tasks: await toTasks(db, project, taskRows.filter(t => !t.deletedAt)) }
}

export async function patchEpic(db: Executor, epicId: string, input: PatchEpicInput, actor: Actor): Promise<Epic> {
  return db.transaction(async (tx) => {
    const { row, project } = await findEpic(tx, epicId)
    const changed = (Object.keys(input) as (keyof PatchEpicInput)[]).filter(k => input[k] !== undefined && input[k] !== row[k])
    if (changed.includes('reviewMode')) {
      const [epic] = await tx.select({ prNumber: epics.prNumber }).from(epics).where(eq(epics.id, epicId)).for('update')
      const taskRows = await tx.select({ status: tasks.status, type: tasks.type, prNumber: tasks.prNumber, integrationProtocol: tasks.integrationProtocol }).from(tasks).where(eq(tasks.epicId, epicId))
      if (reviewModeLocked(epic!, taskRows)) throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: 'The review mode can\'t change once a task in the epic has submitted work or opened a PR' }] })
    }
    if (changed.length > 0) {
      await tx.update(epics).set({ ...input, updatedAt: new Date() }).where(eq(epics.id, epicId))
      await appendAudit(tx, { projectId: row.projectId, actor }, auditEvent('epic.updated', { epicId, changed }))
    }
    return (await listEpics(tx, project)).find(e => e.id === epicId)!
  })
}

// What the writer lock says about each epic, or the stop a human has to clear
async function epicSyncs(db: Executor, project: ProjectRow, rows: EpicRow[]): Promise<Map<string, EpicSync>> {
  const syncs = new Map<string, EpicSync>()
  const ids = rows.filter(r => r.branch).map(r => r.id)
  if (ids.length === 0) return syncs
  const active = await db.select({ operation: taskIntegrationOperations, number: tasks.number }).from(taskIntegrationOperations)
    .leftJoin(tasks, eq(tasks.id, taskIntegrationOperations.resolutionTaskId))
    .where(and(inArray(taskIntegrationOperations.epicId, ids), eq(taskIntegrationOperations.kind, 'rebase'), inArray(taskIntegrationOperations.state, ['pending', 'running', 'reconciling'])))
  for (const { operation, number } of active) {
    const deciding = openDecision(operation)
    syncs.set(operation.epicId, operation.resolutionTaskId
      ? deciding
        ? { state: 'deciding', question: deciding.question, taskId: operation.resolutionTaskId, taskRef: number === null ? null : taskRef(project.prefix, number) }
        : { state: 'resolving', files: operation.conflictFiles ?? [], taskId: operation.resolutionTaskId, taskRef: number === null ? null : taskRef(project.prefix, number) }
      : { state: 'rebasing' })
  }
  for (const row of rows) if (row.syncError) syncs.set(row.id, { state: 'failed', error: row.syncError })
  return syncs
}

async function findEpic(db: Executor, epicId: string): Promise<{ row: EpicRow, project: ProjectRow }> {
  // IDs come from URLs; a malformed one is simply unknown
  if (!/^[0-9a-f-]{36}$/i.test(epicId)) throw notFound()
  const [found] = await db.select({ row: epics, project: projects }).from(epics)
    .innerJoin(projects, eq(projects.id, epics.projectId)).where(eq(epics.id, epicId))
  if (!found) throw notFound()
  return found
}

// A deleted task counts here: its PR may already have merged into the epic branch
function reviewModeLocked(epic: { prNumber: number | null }, taskRows: { status: string, prNumber: number | null, integrationProtocol: number }[]): boolean {
  return epic.prNumber !== null || taskRows.some(t => t.prNumber !== null || t.integrationProtocol > 0 || t.status === 'merged')
}

function toEpic(row: EpicRow, project: ProjectRow, taskRows: (CompletionState & { prNumber: number | null, integrationProtocol: number, deletedAt: Date | null })[], edges: { epicId: string, dependsOnEpicId: string }[], sync: EpicSync | null): Epic {
  const counted = taskRows.filter(t => !t.deletedAt && t.status !== 'draft' && t.status !== 'backlog')
  return {
    id: row.id,
    dependsOn: edges.filter(e => e.epicId === row.id).map(e => e.dependsOnEpicId),
    blocks: edges.filter(e => e.dependsOnEpicId === row.id).map(e => e.epicId),
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    reviewMode: row.reviewMode,
    branch: row.branch,
    prNumber: row.prNumber,
    prUrl: row.prNumber ? `https://github.com/${project.repository}/pull/${row.prNumber}` : null,
    prHeadSha: row.prHeadSha,
    approvedHeadSha: row.approvedHeadSha,
    approvedBaseSha: row.approvedBaseSha,
    reviewState: row.reviewState,
    sync,
    reviewModeLocked: reviewModeLocked(row, taskRows),
    taskCount: counted.length,
    mergedCount: counted.filter(isTaskDone).length,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}

// The epic's whole prerequisite list. Callers have validated the graph; the
// composite keys reject an edge that leaves `projectId`.
export async function replaceEpicDependencies(tx: Executor, projectId: string, epicId: string, dependsOn: string[]): Promise<void> {
  await tx.delete(epicDependencies).where(and(eq(epicDependencies.projectId, projectId), eq(epicDependencies.epicId, epicId)))
  if (dependsOn.length) await tx.insert(epicDependencies).values([...new Set(dependsOn)].map(id => ({ projectId, epicId, dependsOnEpicId: id })))
}

// Serialize graph edits within a project so concurrent requests cannot create a cycle.
export async function setEpicDependencies(db: Executor, epicId: string, dependsOn: string[], actor: Actor): Promise<Epic[]> {
  return db.transaction(async (tx) => {
    const { project } = await findEpic(tx, epicId)
    await tx.select().from(projects).where(eq(projects.id, project.id)).for('update')
    const all = await listEpics(tx, project)
    const graph = new Map(all.map(e => [e.id, e.dependsOn]))
    graph.set(epicId, [...new Set(dependsOn)])
    const rows = await tx.select().from(tasks).where(eq(tasks.projectId, project.id))
    const edges = await tx.select().from(taskDependencies)
    const problems = checkEpicDependencies(graph, rows.map(t => ({
      ...t, deleted: t.deletedAt !== null, dependsOn: edges.filter(e => e.taskId === t.id).map(e => e.dependsOnId)
    })), new Map(all.map(e => [e.id, e.title])))
    if (problems.length) throw new ApiFailure(400, {
      code: 'invalid_input', issues: problems.map(p => ({ message: `Dependency cycle or deadlock: ${p.epics.join(' → ')}` }))
    })
    await replaceEpicDependencies(tx, project.id, epicId, dependsOn)
    await tx.update(epics).set({ updatedAt: new Date() }).where(eq(epics.id, epicId))
    await appendAudit(tx, { projectId: project.id, actor }, auditEvent('epic.updated', { epicId, changed: ['dependsOn'], dependsOn }))
    return listEpics(tx, project)
  })
}
