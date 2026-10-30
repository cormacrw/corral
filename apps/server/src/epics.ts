import type { Epic, EpicDetail, PatchEpicInput } from '@corral/contracts'
import { checkEpicDependencies, isTaskDone, type CompletionState, type Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { ApiFailure, notFound } from './errors.ts'
import { toAuditEntry, toTasks, type ProjectRow } from './tasks.ts'

const { epics, epicDependencies, taskDependencies, projects, tasks } = schema

type EpicRow = typeof epics.$inferSelect

// Epics group a plan's tasks (D9). Counts leave out Drafts and Backlog tasks, which aren't on
// the board yet; the detail includes them so the canvas shows the whole plan.
export async function listEpics(db: Executor, project: ProjectRow): Promise<Epic[]> {
  const rows = await db.select().from(epics).where(eq(epics.projectId, project.id)).orderBy(asc(epics.createdAt))
  const taskRows = await db.select({ epicId: tasks.epicId, status: tasks.status, type: tasks.type, prNumber: tasks.prNumber, deletedAt: tasks.deletedAt }).from(tasks)
    .where(eq(tasks.projectId, project.id))
  const edges = await db.select().from(epicDependencies)
  return rows.map(row => toEpic(row, project, taskRows.filter(t => t.epicId === row.id), edges))
}

export async function getEpic(db: Executor, epicId: string): Promise<EpicDetail> {
  const { row, project } = await findEpic(db, epicId)
  const taskRows = await db.select().from(tasks).where(eq(tasks.epicId, epicId)).orderBy(asc(tasks.number))
  const edges = await db.select().from(epicDependencies)
    .where(or(eq(epicDependencies.epicId, epicId), eq(epicDependencies.dependsOnEpicId, epicId)))
  return { ...toEpic(row, project, taskRows, edges), tasks: await toTasks(db, project, taskRows.filter(t => !t.deletedAt)) }
}

export async function patchEpic(db: Executor, epicId: string, input: PatchEpicInput, actor: Actor): Promise<Epic> {
  return db.transaction(async (tx) => {
    // Read the current mode under the same lock used by epic PR reconciliation.
    const { row, project } = await findEpic(tx, epicId)
    const [epic] = await tx.select().from(epics).where(eq(epics.id, epicId)).for('update')
    const changed = (Object.keys(input) as (keyof PatchEpicInput)[]).filter(k => input[k] !== undefined && input[k] !== epic![k])
    if (changed.includes('reviewMode')) {
      const taskRows = await tx.select({ status: tasks.status, type: tasks.type, prNumber: tasks.prNumber }).from(tasks).where(eq(tasks.epicId, epicId))
      if (reviewModeLocked(epic!, taskRows)) throw new ApiFailure(409, { code: 'invalid_input', issues: [{ message: 'The review mode can\'t change once a task in the epic has opened a PR' }] })
    }
    if (changed.length > 0) {
      await tx.update(epics).set({ ...input, updatedAt: new Date() }).where(eq(epics.id, epicId))
      await appendAudit(tx, { projectId: row.projectId, actor }, auditEvent('epic.updated', { epicId, changed }))
    }
    return (await listEpics(tx, project)).find(e => e.id === epicId)!
  })
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
export function reviewModeLocked(epic: { prNumber: number | null }, taskRows: { status: string, prNumber: number | null }[]): boolean {
  return epic.prNumber !== null || taskRows.some(t => t.prNumber !== null || t.status === 'merged')
}

function toEpic(row: EpicRow, project: ProjectRow, taskRows: (CompletionState & { prNumber: number | null, deletedAt: Date | null })[], edges: { epicId: string, dependsOnEpicId: string }[]): Epic {
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
    reviewState: row.reviewState,
    reviewModeLocked: reviewModeLocked(row, taskRows),
    taskCount: counted.length,
    mergedCount: counted.filter(isTaskDone).length,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
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
    await tx.delete(epicDependencies).where(eq(epicDependencies.epicId, epicId))
    if (dependsOn.length) await tx.insert(epicDependencies).values([...new Set(dependsOn)].map(id => ({ epicId, dependsOnEpicId: id })))
    await tx.update(epics).set({ updatedAt: new Date() }).where(eq(epics.id, epicId))
    await appendAudit(tx, { projectId: project.id, actor }, auditEvent('epic.updated', { epicId, changed: ['dependsOn'], dependsOn }))
    return listEpics(tx, project)
  })
}

// Epic audit entries store the epic id in detail, including dependency edits.
export async function listEpicHistory(db: Executor, epicId: string) {
  await findEpic(db, epicId)
  const rows = await db.select().from(auditLog)
    .where(sql`${auditLog.detail}->>'epicId' = ${epicId}`)
    .orderBy(asc(auditLog.createdAt), asc(auditLog.id))
  return rows.map(toAuditEntry)
}
