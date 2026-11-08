import { normalizeTaskState, parseTaskRef, type TaskState } from '@corral/core'
import { schema, type Executor, type ProjectRow, type TaskRow } from '@corral/db'
import { and, eq, isNull } from 'drizzle-orm'
import { notFound } from './errors.ts'
import { ToolError } from './tool-error.ts'

const { projects, tasks } = schema

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

export async function lockLiveTask(tx: Executor, taskId: string): Promise<{ task: TaskRow, project: ProjectRow } | null> {
  const [found] = await tx.select({ task: tasks, project: projects })
    .from(tasks)
    .innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
    .for('update', { of: tasks })
  return found ?? null
}

// For a task the caller was asked about: one that's gone is a 404
export async function lockTask(tx: Executor, taskId: string): Promise<{ task: TaskRow, project: ProjectRow }> {
  const found = await lockLiveTask(tx, taskId)
  if (!found) throw notFound()
  return found
}

export async function findTaskId(db: Executor, projectId: string, number: number): Promise<string> {
  const [row] = await db.select({ id: tasks.id }).from(tasks)
    .where(and(eq(tasks.projectId, projectId), eq(tasks.number, number), isNull(tasks.deletedAt)))
  if (!row) throw notFound()
  return row.id
}

const refNumber = (project: Pick<ProjectRow, 'prefix'>, ref: string): number | null => {
  const parsed = parseTaskRef(ref.trim())
  return parsed?.prefix === project.prefix ? parsed.number : null
}

// Whether a ref is written with this project's prefix
export const isProjectRef = (project: Pick<ProjectRow, 'prefix'>, ref: string): boolean => refNumber(project, ref) !== null

// The live task a ref names in this project, if any
export async function taskByRef(db: Executor, project: Pick<ProjectRow, 'id' | 'prefix'>, ref: string): Promise<TaskRow | null> {
  const number = refNumber(project, ref)
  if (number === null) return null
  const [task] = await db.select().from(tasks)
    .where(and(eq(tasks.projectId, project.id), eq(tasks.number, number), isNull(tasks.deletedAt)))
  return task ?? null
}

// An agent's task ref, from its project only. The message goes to the agent.
export async function findTaskByRef(db: Executor, project: Pick<ProjectRow, 'id' | 'prefix'>, ref: string): Promise<TaskRow> {
  if (!isProjectRef(project, ref)) throw new ToolError(`No task ${ref} in this project (refs look like ${project.prefix}-12)`)
  const task = await taskByRef(db, project, ref)
  if (!task) throw new ToolError(`No task ${ref} in this project`)
  return task
}

// The live task a ref names in whichever project has its prefix, if any
export async function taskAndProjectByRef(db: Executor, ref: string): Promise<{ task: TaskRow, project: ProjectRow } | null> {
  const parsed = parseTaskRef(ref)
  if (!parsed) return null
  const [found] = await db.select({ task: tasks, project: projects }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(eq(projects.prefix, parsed.prefix), eq(tasks.number, parsed.number), isNull(tasks.deletedAt)))
  return found ?? null
}
