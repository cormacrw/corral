// Task dependency graph checks. Dependencies must form a DAG (D9) and may only
// point at tasks that exist.
export type DependencyProblem =
  | { code: 'self_dependency', taskId: string }
  | { code: 'unknown_dependency', taskId: string, dependsOn: string }
  | { code: 'cycle', path: string[] }

// `graph` maps each task ID to the IDs it depends on
export function checkDependencies(graph: ReadonlyMap<string, readonly string[]>): DependencyProblem[] {
  const problems: DependencyProblem[] = []
  for (const [taskId, deps] of graph) {
    for (const dep of deps) {
      if (dep === taskId) {
        problems.push({ code: 'self_dependency', taskId })
      } else if (!graph.has(dep)) {
        problems.push({ code: 'unknown_dependency', taskId, dependsOn: dep })
      }
    }
  }
  const cycle = findCycle(graph)
  if (cycle) problems.push({ code: 'cycle', path: cycle })
  return problems
}

// Returns one cycle as a path that starts and ends on the same task, or null.
// Self-dependencies and unknown IDs are skipped; checkDependencies reports them.
export function findCycle(graph: ReadonlyMap<string, readonly string[]>): string[] | null {
  const done = new Set<string>()
  const onPath = new Set<string>()
  const path: string[] = []

  // Iterative DFS so a long chain of tasks can't overflow the stack
  for (const start of graph.keys()) {
    if (done.has(start)) continue
    const stack: { id: string, next: number }[] = [{ id: start, next: 0 }]
    onPath.add(start)
    path.push(start)

    while (stack.length > 0) {
      const frame = stack[stack.length - 1]!
      const deps = graph.get(frame.id) ?? []
      if (frame.next < deps.length) {
        const dep = deps[frame.next++]!
        if (dep === frame.id) continue
        if (onPath.has(dep)) {
          return [...path.slice(path.indexOf(dep)), dep]
        }
        if (!done.has(dep) && graph.has(dep)) {
          stack.push({ id: dep, next: 0 })
          onPath.add(dep)
          path.push(dep)
        }
      } else {
        stack.pop()
        onPath.delete(frame.id)
        path.pop()
        done.add(frame.id)
      }
    }
  }
  return null
}
