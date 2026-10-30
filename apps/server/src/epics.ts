import type { Epic, EpicDetail, PatchEpicInput } from '@corral/contracts'
import { checkEpicDependencies, type Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, eq, isNull, or, sql } from 'drizzle-orm'
import { ApiFailure, notFound } from './errors.ts'
import { toAuditEntry, toTasks, type ProjectRow } from './tasks.ts'

const { auditLog, epics, epicDependencies, taskDependencies, projects, tasks } = schema

type EpicRow = typeof epics.$inferSelect

// Epics group a plan's tasks (D9). Counts leave out Drafts and Backlog tasks, which aren't on
// the board yet; the detail includes them so the canvas shows the whole plan.
export async function listEpics(db: Executor, project: ProjectRow): Promise<Epic[]> {
  const rows = await db.select().from(epics).where(eq(epics.projectId, project.id)).orderBy(asc(epics.createdAt))
  const counted = await db.select({ epicId: tasks.epicId, status: tasks.status }).from(tasks)
    .where(and(eq(tasks.projectId, project.id), isNull(tasks.deletedAt)))
  const edges = await db.select().from(epicDependencies)
  return rows.map(row => toEpic(row, counted.filter(t => t.epicId === row.id), edges))
}

export async function getEpic(db: Executor, epicId: string): Promise<EpicDetail> {
  const { row, project } = await findEpic(db, epicId)
  const taskRows = await db.select().from(tasks)
    .where(and(eq(tasks.epicId, epicId), isNull(tasks.deletedAt))).orderBy(asc(tasks.number))
  const edges = await db.select().from(epicDependencies)
    .where(or(eq(epicDependencies.epicId, epicId), eq(epicDependencies.dependsOnEpicId, epicId)))
  return { ...toEpic(row, taskRows, edges), tasks: await toTasks(db, project, taskRows) }
}

export async function patchEpic(db: Executor, epicId: string, input: PatchEpicInput, actor: Actor): Promise<Epic> {
  const { row, project } = await findEpic(db, epicId)
  const changed = (Object.keys(input) as (keyof PatchEpicInput)[]).filter(k => input[k] !== undefined && input[k] !== row[k])
  if (changed.length > 0) {
    await db.update(epics).set({ ...input, updatedAt: new Date() }).where(eq(epics.id, epicId))
    await db.insert(auditLog).values({ projectId: row.projectId, actor, action: 'epic.updated', detail: { epicId, changed } })
  }
  return (await listEpics(db, project)).find(e => e.id === epicId)!
}

async function findEpic(db: Executor, epicId: string): Promise<{ row: EpicRow, project: ProjectRow }> {
  // IDs come from URLs; a malformed one is simply unknown
  if (!/^[0-9a-f-]{36}$/i.test(epicId)) throw notFound()
  const [found] = await db.select({ row: epics, project: projects }).from(epics)
    .innerJoin(projects, eq(projects.id, epics.projectId)).where(eq(epics.id, epicId))
  if (!found) throw notFound()
  return found
}

function toEpic(row: EpicRow, taskStatuses: { status: string }[], edges: { epicId: string, dependsOnEpicId: string }[]): Epic {
  const counted = taskStatuses.filter(t => t.status !== 'draft' && t.status !== 'backlog')
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
    prHeadSha: row.prHeadSha,
    reviewState: row.reviewState,
    taskCount: counted.length,
    mergedCount: counted.filter(t => t.status === 'merged').length,
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
    await tx.insert(auditLog).values({ projectId: project.id, actor, action: 'epic.updated', detail: { epicId, changed: ['dependsOn'], dependsOn } })
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
