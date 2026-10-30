import { checkDependencies, findCycle, type DependencyProblem } from './dependencies.ts'
import { isTaskDone, isUnfinishedBoardTask, type CompletionState } from './completion.ts'

export interface EpicDependencyTask extends CompletionState {
  id: string
  epicId: string | null
  deleted?: boolean
  dependsOn: readonly string[]
}

export type EpicDependencyProblem =
  | { code: 'epic_dependency', problem: DependencyProblem, epics: string[] }
  | { code: 'epic_task_deadlock', path: string[], epics: string[] }

// Validate the complete proposed setup, before writing it. Keys are epic IDs;
// titles are supplied separately so errors name the epics a human recognises.
export function checkEpicDependencies(
  epicGraph: ReadonlyMap<string, readonly string[]>,
  tasks: readonly EpicDependencyTask[],
  titles: ReadonlyMap<string, string> = new Map()
): EpicDependencyProblem[] {
  const name = (id: string) => titles.get(id) ?? id
  const problems: EpicDependencyProblem[] = checkDependencies(epicGraph).map(problem => ({
    code: 'epic_dependency',
    problem,
    epics: (problem.code === 'cycle'
      ? problem.path
      : problem.code === 'self_dependency'
        ? [problem.taskId]
        : [problem.taskId, problem.dependsOn]).map(name)
  }))
  if (problems.length) return problems

  // An epic completion node waits on its unfinished board tasks. Each task
  // waits on its explicit prerequisites and its epic's prerequisite epics.
  // A cycle here detects deadlocks through any number of epics/tasks, without
  // incorrectly treating every cross-epic task edge as an epic dependency.
  const graph = new Map<string, string[]>()
  for (const id of epicGraph.keys()) graph.set(`epic:${id}`, [])
  const unfinished = tasks.filter(t => !t.deleted && !isTaskDone(t))
  const ids = new Set(unfinished.map(t => t.id))
  for (const task of unfinished) {
    graph.set(`task:${task.id}`, [
      ...task.dependsOn.filter(id => ids.has(id)).map(id => `task:${id}`),
      ...(task.epicId ? epicGraph.get(task.epicId) ?? [] : []).map(id => `epic:${id}`)
    ])
    if (task.epicId && isUnfinishedBoardTask(task)) {
      graph.get(`epic:${task.epicId}`)?.push(`task:${task.id}`)
    }
  }
  const path = findCycle(graph)
  if (path) {
    const involved = new Set<string>()
    for (const node of path) {
      const id = node.slice(5)
      const epicId = node.startsWith('epic:') ? id : tasks.find(t => t.id === id)?.epicId
      if (epicId) involved.add(epicId)
    }
    problems.push({ code: 'epic_task_deadlock', path, epics: [...involved].map(name) })
  }
  return problems
}
