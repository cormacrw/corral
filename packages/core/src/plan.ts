import { checkDependencies, type DependencyProblem } from './dependencies.ts'
import type { TaskPriority, TaskType } from './task.ts'

// What the PM proposes with `propose_plan` (D9). Keys are the PM's own
// handles for epics and tasks inside one plan, so dependencies and
// revisions can refer to them before anything exists.
export interface ProposedEpic {
  key: string
  title: string
  summary: string
}

export interface ProposedTask {
  key: string
  // The key of the epic it belongs to
  epic: string
  title: string
  description: string
  type: TaskType
  priority: TaskPriority
  humanReview: boolean
  acceptanceCriteria: string[]
  dependsOn: string[]
}

export interface ProposedPlan {
  title: string
  summary: string
  epics: ProposedEpic[]
  tasks: ProposedTask[]
}

export type PlanProblem =
  | { code: 'no_tasks' }
  | { code: 'duplicate_epic_key', key: string }
  | { code: 'missing_epic_title', key: string }
  | { code: 'empty_epic', key: string }
  | { code: 'unknown_epic', key: string, epic: string }
  | { code: 'duplicate_key', key: string }
  | { code: 'missing_title', key: string }
  | { code: 'missing_description', key: string }
  | { code: 'missing_acceptance_criteria', key: string }
  | { code: 'blank_acceptance_criterion', key: string }
  | { code: 'dependency', problem: DependencyProblem }

// D9: a plan is saved only if the dependencies form a DAG and every task
// has acceptance criteria. Returns every problem, so the PM can fix them all.
export function checkPlan(plan: ProposedPlan): PlanProblem[] {
  const problems: PlanProblem[] = []
  if (plan.tasks.length === 0) return [{ code: 'no_tasks' }]
  const epicKeys = new Set<string>()
  for (const epic of plan.epics) {
    if (epicKeys.has(epic.key)) problems.push({ code: 'duplicate_epic_key', key: epic.key })
    epicKeys.add(epic.key)
    if (!epic.title.trim()) problems.push({ code: 'missing_epic_title', key: epic.key })
    if (!plan.tasks.some(t => t.epic === epic.key)) problems.push({ code: 'empty_epic', key: epic.key })
  }
  const seen = new Set<string>()
  for (const task of plan.tasks) {
    if (!epicKeys.has(task.epic)) problems.push({ code: 'unknown_epic', key: task.key, epic: task.epic })
    if (seen.has(task.key)) problems.push({ code: 'duplicate_key', key: task.key })
    seen.add(task.key)
    if (!task.title.trim()) problems.push({ code: 'missing_title', key: task.key })
    if (!task.description.trim()) problems.push({ code: 'missing_description', key: task.key })
    if (task.acceptanceCriteria.length === 0) problems.push({ code: 'missing_acceptance_criteria', key: task.key })
    else if (task.acceptanceCriteria.some(c => !c.trim())) problems.push({ code: 'blank_acceptance_criterion', key: task.key })
  }
  const graph = new Map(plan.tasks.map(t => [t.key, t.dependsOn]))
  for (const problem of checkDependencies(graph)) problems.push({ code: 'dependency', problem })
  return problems
}

export type PlanChange = 'added' | 'changed' | 'unchanged' | 'removed'

// How a revised plan differs from the previous version, by key (design/plan.md)
export function diffPlans(previous: readonly ProposedTask[], next: readonly ProposedTask[]): { key: string, change: PlanChange }[] {
  const before = new Map(previous.map(t => [t.key, t]))
  const result: { key: string, change: PlanChange }[] = next.map((task) => {
    const old = before.get(task.key)
    if (!old) return { key: task.key, change: 'added' }
    return { key: task.key, change: sameTask(old, task) ? 'unchanged' : 'changed' }
  })
  for (const task of previous) {
    if (!next.some(t => t.key === task.key)) result.push({ key: task.key, change: 'removed' })
  }
  return result
}

function sameTask(a: ProposedTask, b: ProposedTask): boolean {
  return a.title === b.title
    && a.epic === b.epic
    && a.description === b.description
    && a.type === b.type
    && a.priority === b.priority
    && a.humanReview === b.humanReview
    && a.acceptanceCriteria.length === b.acceptanceCriteria.length
    && a.acceptanceCriteria.every((c, i) => c === b.acceptanceCriteria[i])
    && a.dependsOn.length === b.dependsOn.length
    && a.dependsOn.every(d => b.dependsOn.includes(d))
}
