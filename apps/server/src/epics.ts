import type { Epic, EpicDetail, PatchEpicInput } from '@corral/contracts'
import type { Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { notFound } from './errors.ts'
import { toTasks, type ProjectRow } from './tasks.ts'

const { auditLog, epics, projects, tasks } = schema

type EpicRow = typeof epics.$inferSelect

// Epics group a plan's tasks (D9). Counts leave out Drafts, which aren't on
// the board yet; the detail includes them so the canvas shows the whole plan.
export async function listEpics(db: Executor, project: ProjectRow): Promise<Epic[]> {
  const rows = await db.select().from(epics).where(eq(epics.projectId, project.id)).orderBy(asc(epics.createdAt))
  const counted = await db.select({ epicId: tasks.epicId, status: tasks.status }).from(tasks)
    .where(and(eq(tasks.projectId, project.id), isNull(tasks.deletedAt)))
  return rows.map(row => toEpic(row, counted.filter(t => t.epicId === row.id)))
}

export async function getEpic(db: Executor, epicId: string): Promise<EpicDetail> {
  const { row, project } = await findEpic(db, epicId)
  const taskRows = await db.select().from(tasks)
    .where(and(eq(tasks.epicId, epicId), isNull(tasks.deletedAt))).orderBy(asc(tasks.number))
  return { ...toEpic(row, taskRows), tasks: await toTasks(db, project, taskRows) }
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

function toEpic(row: EpicRow, taskStatuses: { status: string }[]): Epic {
  const counted = taskStatuses.filter(t => t.status !== 'draft')
  return {
    id: row.id,
    projectId: row.projectId,
    title: row.title,
    description: row.description,
    taskCount: counted.length,
    mergedCount: counted.filter(t => t.status === 'merged').length,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString()
  }
}
