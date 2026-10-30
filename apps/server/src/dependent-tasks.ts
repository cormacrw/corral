import { schema, type Executor } from '@corral/db'
import { and, eq, isNull, notInArray } from 'drizzle-orm'
import { unfinishedTask } from './completion.ts'
import type { EventBus } from './events.ts'
import { loadTask } from './tasks.ts'

// Called after completion commits, including designs and spikes without a PR.
// Return IDs as well as publishing, so the scheduler bypasses wake intervals.
export async function publishDependents(db: Executor, events: EventBus, taskId: string): Promise<string[]> {
  const { tasks, taskDependencies, epicDependencies } = schema
  const ids = new Set((await db.select({ id: taskDependencies.taskId }).from(taskDependencies)
    .where(eq(taskDependencies.dependsOnId, taskId))).map(t => t.id))
  const [task] = await db.select().from(tasks).where(eq(tasks.id, taskId))
  if (task?.epicId) {
    const [open] = await db.select({ id: tasks.id }).from(tasks).where(and(
      eq(tasks.epicId, task.epicId), isNull(tasks.deletedAt),
      and(notInArray(tasks.status, ['draft', 'backlog']), unfinishedTask(tasks))
    )).limit(1)
    if (!open) {
      const dependents = await db.select({ id: tasks.id }).from(epicDependencies)
        .innerJoin(tasks, eq(tasks.epicId, epicDependencies.epicId))
        .where(and(eq(epicDependencies.dependsOnEpicId, task.epicId), isNull(tasks.deletedAt)))
      for (const dependent of dependents) ids.add(dependent.id)
    }
  }
  for (const id of ids) {
    const dependent = await loadTask(db, id).catch(() => null)
    if (dependent) events.publish({ type: 'task.updated', task: dependent })
  }
  return [...ids]
}
