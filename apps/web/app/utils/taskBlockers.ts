import type { Task } from '@corral/contracts'
import { isTaskDone } from '@corral/core'

// Use the entire project list, before Board filters or the merged window.
export function taskBlockers(task: Pick<Task, 'status' | 'dependsOn' | 'waitingOnEpics'>, tasks: Task[]) {
  if (task.status !== 'ready') return { tasks: [], epics: [] }
  return {
    tasks: tasks.filter(candidate => task.dependsOn.includes(candidate.ref) && !isTaskDone(candidate)),
    epics: task.waitingOnEpics
  }
}
