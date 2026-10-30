import { schema, type Executor } from '@corral/db'
import { and, eq, isNull } from 'drizzle-orm'
import { holdsEpicOpen } from './epic-review-state.ts'
import type { EventBus } from './events.ts'
import { loadTask } from './tasks.ts'

const { epics, epicDependencies, taskDependencies, tasks } = schema

// Called after a merge commits, including spikes that complete without a PR.
// Return IDs as well as publishing, so the scheduler bypasses wake intervals.
export async function publishDependents(db: Executor, events: EventBus, taskId: string): Promise<string[]> {
  const ids = (await db.select({ id: taskDependencies.taskId }).from(taskDependencies)
    .where(eq(taskDependencies.dependsOnId, taskId))).map(t => t.id)
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
  return publish(db, events, [...ids, ...task?.epicId ? await epicDependents(db, task.epicId) : []])
}

// Called when an epic PR merges (D22, D27): tasks in dependent epics can start,
// and so can tasks elsewhere that depend on one of its tasks
export async function publishEpicDependents(db: Executor, events: EventBus, epicId: string): Promise<string[]> {
  const crossEpic = await db.select({ id: taskDependencies.taskId }).from(taskDependencies)
    .innerJoin(tasks, eq(tasks.id, taskDependencies.dependsOnId))
    .where(eq(tasks.epicId, epicId))
  return publish(db, events, [...await epicDependents(db, epicId), ...crossEpic.map(t => t.id)])
}

async function epicDependents(db: Executor, epicId: string): Promise<string[]> {
  const [open] = await db.select({ id: tasks.id }).from(tasks).innerJoin(epics, eq(epics.id, tasks.epicId))
    .where(and(eq(epics.id, epicId), holdsEpicOpen(tasks, epics))).limit(1)
  if (open) return []
  return (await db.select({ id: tasks.id }).from(epicDependencies)
    .innerJoin(tasks, eq(tasks.epicId, epicDependencies.epicId))
    .where(and(eq(epicDependencies.dependsOnEpicId, epicId), isNull(tasks.deletedAt)))).map(t => t.id)
}

async function publish(db: Executor, events: EventBus, taskIds: string[]): Promise<string[]> {
  const ids = [...new Set(taskIds)]
  for (const id of ids) {
    const dependent = await loadTask(db, id).catch(() => null)
    if (dependent) events.publish({ type: 'task.updated', task: dependent })
  }
  return ids
}
