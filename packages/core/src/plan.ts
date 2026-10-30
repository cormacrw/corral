import { checkEpicDependencies, type EpicDependencyProblem, type EpicDependencyTask } from './epic-dependencies.ts'
import { checkDependencies, type DependencyProblem } from './dependencies.ts'
import type { DesignVersionStatus } from './design.ts'
import type { EpicReviewMode } from './project.ts'
import type { TaskStatus } from './status.ts'
import type { TaskPriority, TaskType } from './task.ts'

// A plan version's lifecycle (design/plan.md)
export const PLAN_STATUSES = ['proposed', 'approved', 'superseded', 'discarded'] as const
export type PlanStatus = typeof PLAN_STATUSES[number]

// What the PM proposes with `propose_plan` (D9). Keys are the PM's own
// handles for epics and tasks inside one plan, so dependencies and
// revisions can refer to them before anything exists.
export interface ProposedEpic {
  key: string
  title: string
  summary: string
  dependsOn?: string[] | undefined
  // How its tasks reach the target branch (D27); the project's default
  // when left out
  reviewMode?: EpicReviewMode | undefined
}

export interface ProposedTask {
  key: string
  // The ref of an existing task this one revises (e.g. COR-4), instead of
  // creating a new one
  ref?: string | undefined
  // The key of the epic it belongs to (or its existing id when reconstructing
  // edited Drafts for approval). A task without one has no
  // epic.
  epic?: string | undefined
  title: string
  description: string
  type: TaskType
  priority: TaskPriority
  humanReview: boolean
  acceptanceCriteria: (string | { text: string, checkedByHuman?: boolean | undefined })[]
  dependsOn: string[]
  // The approved design version this task builds, and the screens (ids
  // from its design.md) it covers (D20)
  design?: DesignPin | undefined
}

export interface DesignPin {
  // The design task, e.g. COR-70
  taskRef: string
  version: number
  screens: string[]
}

export interface ProposedPlan {
  title: string
  summary: string
  epics: ProposedEpic[]
  tasks: ProposedTask[]
}

export type PlanProblem =
  | EpicDependencyProblem
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
  | { code: 'duplicate_ref', key: string, ref: string }
  | { code: 'unknown_ref', key: string, ref: string, message: string }
  | { code: 'deleted_ref', key: string, ref: string, message: string }
  | { code: 'ref_in_other_project', key: string, ref: string, project: string, message: string }
  | { code: 'ref_not_revisable', key: string, ref: string, status: TaskStatus, message: string }
  | { code: 'design_not_found', key: string, design: string, message: string }
  | { code: 'design_not_approved', key: string, design: string, status: DesignVersionStatus, message: string }
  | { code: 'design_without_screens', key: string, design: string, message: string }

// What an existing task's ref points at, looked up by the server before
// checkPlan runs
export type PlanRef =
  | { kind: 'task', status: TaskStatus }
  | { kind: 'unknown' }
  | { kind: 'deleted' }
  | { kind: 'other_project', project: string }

// What a design pin points at, looked up by the server before checkPlan
// runs. Keyed by designPinKey.
export type DesignPinTarget =
  | { kind: 'version', status: DesignVersionStatus }
  | { kind: 'not_design', status: TaskStatus }
  | { kind: 'unknown' }

export function designPinKey(pin: Pick<DesignPin, 'taskRef' | 'version'>): string {
  return `${pin.taskRef.toUpperCase()}@v${pin.version}`
}

// Only tasks nobody has started can be revised by a plan
export const REVISABLE_STATUSES: readonly TaskStatus[] = ['backlog', 'draft']

// Identity maps match proposed keys to rows reused by a revision.
export interface PlanDependencyContext {
  epics: ReadonlyMap<string, readonly string[]>
  titles: ReadonlyMap<string, string>
  tasks: readonly EpicDependencyTask[]
  epicIds: ReadonlyMap<string, string>
  taskIds: ReadonlyMap<string, string>
  refIds: ReadonlyMap<string, string>
}

// D9: a plan is saved only if the dependencies form a DAG and every task
// has acceptance criteria. Returns every problem, so the PM can fix them all.
// `refs` holds every existing-task ref the plan names, in `ref` or
// `dependsOn`; a task may revise only a Backlog task or a Draft, but may
// depend on any task in the project. `designs` holds every design pin's
// target by designPinKey; a task may pin only an approved version (D20).
export function checkPlan(plan: ProposedPlan, refs: ReadonlyMap<string, PlanRef> = new Map(), designs: ReadonlyMap<string, DesignPinTarget> = new Map(), context?: PlanDependencyContext): PlanProblem[] {
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
    if (task.epic && !epicKeys.has(task.epic)) problems.push({ code: 'unknown_epic', key: task.key, epic: task.epic })
    if (seen.has(task.key)) problems.push({ code: 'duplicate_key', key: task.key })
    seen.add(task.key)
    if (!task.title.trim()) problems.push({ code: 'missing_title', key: task.key })
    if (!task.description.trim()) problems.push({ code: 'missing_description', key: task.key })
    if (task.acceptanceCriteria.length === 0) problems.push({ code: 'missing_acceptance_criteria', key: task.key })
    else if (task.acceptanceCriteria.some(c => !(typeof c === 'string' ? c : c.text).trim())) problems.push({ code: 'blank_acceptance_criterion', key: task.key })
    if (task.ref) {
      const problem = refProblem(task.key, task.ref, refs.get(task.ref) ?? { kind: 'unknown' }, true)
      if (problem) problems.push(problem)
      if (plan.tasks.some(t => t !== task && t.ref === task.ref) && !problems.some(p => p.code === 'duplicate_ref' && p.ref === task.ref)) {
        problems.push({ code: 'duplicate_ref', key: task.key, ref: task.ref })
      }
    }
    if (task.design) {
      const problem = designProblem(task.key, task.design, designs.get(designPinKey(task.design)) ?? { kind: 'unknown' })
      if (problem) problems.push(problem)
    }
  }
  // A dependency names a key in the plan, the ref of a task the plan
  // revises (the same node), or any other existing task (outside the graph)
  const keyOfRef = new Map(plan.tasks.filter(t => t.ref).map(t => [t.ref!, t.key]))
  const keys = new Set(plan.tasks.map(t => t.key))
  const graph = new Map(plan.tasks.map(t => [t.key, t.dependsOn.flatMap((dep) => {
    if (keys.has(dep)) return [dep]
    const key = keyOfRef.get(dep)
    if (key) return [key]
    const found = refs.get(dep)
    if (!found) return [dep]
    const problem = refProblem(t.key, dep, found, false)
    if (problem) problems.push(problem)
    return []
  })]))
  for (const problem of checkDependencies(graph)) problems.push({ code: 'dependency', problem })
  const taskCycle = problems.some(p => p.code === 'dependency' && p.problem.code === 'cycle')
  problems.push(...checkPlanEpicDependencies(plan, context).filter(p => !taskCycle || p.code !== 'epic_task_deadlock'))
  return problems
}

// Overlay the proposal on the complete project graph. Approval uses this
// separately because Drafts may have been edited directly since proposing.
export function checkPlanEpicDependencies(plan: ProposedPlan, context?: PlanDependencyContext): EpicDependencyProblem[] {
  const epicKeys = new Set(plan.epics.map(e => e.key))
  const epicId = (key: string) => context?.epicIds.get(key) ?? (epicKeys.has(key) ? `plan-epic:${key}` : key)
  const taskId = (task: ProposedTask) => (task.ref ? context?.refIds.get(task.ref) : undefined) ?? context?.taskIds.get(task.key) ?? `plan-task:${task.key}`
  const epicGraph = new Map(context?.epics)
  const titles = new Map(context?.titles)
  for (const epic of plan.epics) {
    titles.set(epicId(epic.key), epic.title)
    epicGraph.set(epicId(epic.key), (epic.dependsOn ?? []).map(dep => epicKeys.has(dep) ? epicId(dep) : dep))
  }
  const proposedIds = new Map(plan.tasks.map(t => [t.key, taskId(t)]))
  const proposedRefs = new Map(plan.tasks.filter(t => t.ref).map(t => [t.ref!, taskId(t)]))
  const effectiveTasks = new Map((context?.tasks ?? []).map(t => [t.id, t]))
  for (const task of plan.tasks) {
    const id = taskId(task)
    effectiveTasks.set(id, {
      id, epicId: task.epic ? epicId(task.epic) : null,
      // Validate as board work even though proposed tasks are stored as Drafts.
      status: 'ready',
      dependsOn: task.dependsOn.map(dep => proposedIds.get(dep) ?? proposedRefs.get(dep) ?? context?.refIds.get(dep) ?? dep)
    })
  }
  return checkEpicDependencies(epicGraph, [...effectiveTasks.values()], titles).filter(p => p.code !== 'epic_task_deadlock' || p.epics.length > 0)
}

function refProblem(key: string, ref: string, found: PlanRef, revising: boolean): PlanProblem | null {
  switch (found.kind) {
    case 'unknown':
      return { code: 'unknown_ref', key, ref, message: `There is no task ${ref} in this project. Check the ref with list_tasks.` }
    case 'deleted':
      return { code: 'deleted_ref', key, ref, message: `${ref} was deleted. ${revising ? 'Leave out its ref to propose it as a new task.' : 'Remove it from dependsOn.'}` }
    case 'other_project':
      return { code: 'ref_in_other_project', key, ref, project: found.project, message: `${ref} belongs to the project "${found.project}", not this one.` }
    case 'task':
      if (!revising || REVISABLE_STATUSES.includes(found.status)) return null
      return { code: 'ref_not_revisable', key, ref, status: found.status, message: `${ref} is ${found.status}; only Backlog tasks can be revised by a plan. Leave out its ref to propose a new task, or depend on it instead.` }
  }
}

function designProblem(key: string, pin: DesignPin, found: DesignPinTarget): PlanProblem | null {
  const design = designPinKey(pin).replace('@', ' ')
  switch (found.kind) {
    case 'unknown':
      return { code: 'design_not_found', key, design, message: `There is no design ${design} in this project. Check the version with get_design.` }
    case 'not_design':
      return { code: 'design_not_found', key, design, message: `${pin.taskRef} isn't a design task, so it has no versions to pin.` }
    case 'version':
      if (found.status !== 'approved') return { code: 'design_not_approved', key, design, status: found.status, message: `Design ${design} is ${found.status}; pin only the approved version.` }
      if (pin.screens.length === 0 || pin.screens.some(s => !s.trim())) return { code: 'design_without_screens', key, design, message: 'List the screen ids (from design.md) the task covers.' }
      return null
  }
}

export const PLAN_CHANGES = ['added', 'changed', 'unchanged', 'removed'] as const
export type PlanChange = typeof PLAN_CHANGES[number]

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
    && a.ref === b.ref
    && (a.epic || undefined) === (b.epic || undefined)
    && a.description === b.description
    && a.type === b.type
    && a.priority === b.priority
    && a.humanReview === b.humanReview
    && a.acceptanceCriteria.length === b.acceptanceCriteria.length
    && a.acceptanceCriteria.every((c, i) => JSON.stringify(c) === JSON.stringify(b.acceptanceCriteria[i]))
    && a.dependsOn.length === b.dependsOn.length
    && a.dependsOn.every(d => b.dependsOn.includes(d))
    && samePin(a.design, b.design)
}

function samePin(a: DesignPin | undefined, b: DesignPin | undefined): boolean {
  if (!a || !b) return !a && !b
  return designPinKey(a) === designPinKey(b) && a.screens.length === b.screens.length && a.screens.every(s => b.screens.includes(s))
}
