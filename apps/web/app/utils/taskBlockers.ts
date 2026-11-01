import type { Task } from '@corral/contracts'
import { isTaskDone } from '@corral/core'

// Use the entire project list, before Board filters or the merged window. Lists
// leave out Drafts, so a dependency that isn't listed is one the scheduler still
// waits on: it comes back as a bare ref in `unlisted`.
export function taskBlockers(task: Pick<Task, 'status' | 'dependsOn' | 'waitingOnEpics'>, tasks: Task[]) {
  if (task.status !== 'ready') return { tasks: [], unlisted: [], epics: [] }
  return {
    tasks: tasks.filter(candidate => task.dependsOn.includes(candidate.ref) && !isTaskDone(candidate)),
    unlisted: task.dependsOn.filter(ref => !tasks.some(candidate => candidate.ref === ref)),
    epics: task.waitingOnEpics
  }
}
