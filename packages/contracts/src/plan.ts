import { requiresHumanReview, TASK_PRIORITIES, TASK_REF_PATTERN, TASK_TYPES, type ProposedPlan } from '@corral/core'
import { z } from 'zod'
import { advertisedPlanReviewMode, planReviewModeInput } from './wire-compat.ts'

const proposedTask = z.object({
  key: z.string().trim().min(1).describe('A short handle used by dependsOn, e.g. t1'),
  ref: z.string().trim().toUpperCase().optional().transform(ref => ref || undefined).describe('The ref of an existing Backlog or unclaimed Ready task this revises, e.g. COR-4; leave out for a new task'),
  parent: z.string().trim().optional().describe('The key of its parent in `parents`, or the ref of the task it belongs to; leave it out for a task on its own'),
  title: z.string().trim().min(1),
  description: z.string().trim().describe('Markdown: one to three plain sentences a person reads to know what the task is and why. Put the approach, files and edge cases in implementationPlan'),
  implementationPlan: z.string().trim().optional().describe('Markdown for the agent that builds it: approach, file pointers, edge cases and test notes. On a task with a ref, include its current plan (from get_task) to keep it: a revision without one clears it'),
  type: z.enum(TASK_TYPES),
  priority: z.enum(TASK_PRIORITIES).default('medium'),
  humanReview: z.boolean().optional().describe('Leave it out to use the default: a new top-level task takes the project\'s human review default, a new sub-task starts without one, and a task with a ref keeps its current setting. Where the project reviews by default, a new task can\'t set it to false'),
  acceptanceCriteria: z.array(z.union([z.string().trim(), z.object({ text: z.string().trim(), checkedByHuman: z.boolean().optional() })])).default([]),
  dependsOn: z.array(z.string().trim()).default([]).describe('Keys of tasks in this plan, or refs of existing tasks'),
  // The approved design version a build task builds (D20)
  design: z.object({
    taskRef: z.string().trim().toUpperCase().describe('The design task, e.g. COR-70'),
    version: z.number().int().positive().describe('Its approved version'),
    screens: z.array(z.string().trim()).default([]).describe('Ids of the screens in design.md this task builds')
  }).optional().describe('For a task that builds part of an approved design: the version and the screens it covers')
})

const REVIEW_MODE_HELP = 'How its subtasks reach the target branch: parent = human reviews the task\'s PR; direct = subtasks merge straight into the target branch. Leave it out for the project\'s default.'
const parentFields = {
  key: z.string().trim().min(1).describe('A short handle referenced by each subtask’s `parent`, e.g. p1'),
  ref: z.string().trim().toUpperCase().optional().transform(ref => ref || undefined).describe('An existing task to add to, or a Draft, Backlog or unclaimed Ready task with no runs to turn into one, e.g. COR-4. It keeps its ref and comments, and its criteria move to its first subtask. Leave out for a new task'),
  title: z.string().trim().default('').describe('Required for a new task'),
  summary: z.string().trim().default(''),
  dependsOn: z.array(z.string().trim()).optional().describe('Task keys in this plan or refs of existing tasks with subtasks. Omit to keep dependencies in a revision; [] clears them. Subtasks wait until these tasks with subtasks are done.')
}

export const proposedPlanInput = z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().default(''),
  parents: z.array(z.object({ ...parentFields, reviewMode: planReviewModeInput.describe(REVIEW_MODE_HELP) })).default([]),
  tasks: z.array(proposedTask)
})

// What the PM is offered: the same plan, with review modes before they're stored
export const advertisedPlanInput = {
  ...proposedPlanInput.omit({ parents: true }).shape,
  parents: z.array(z.object({ ...parentFields, reviewMode: advertisedPlanReviewMode.describe(REVIEW_MODE_HELP) })).default([])
}

// Keep wire compatibility and normalization at the boundary, outside core.
export type ProposedPlanInput = z.output<typeof proposedPlanInput>

export function normalizeProposedPlan(input: ProposedPlanInput): ProposedPlan {
  const { parents, ...plan } = input
  const keys = new Set(plan.tasks.map(t => t.key))
  const dependency = (dep: string) => keys.has(dep) || !TASK_REF_PATTERN.test(dep) ? dep : dep.toUpperCase()
  const parentKeys = new Set(parents.map(p => p.key))
  // A parent named only by its ref on a task
  const named = [...new Set(plan.tasks.flatMap(t => t.parent && !parentKeys.has(t.parent) && TASK_REF_PATTERN.test(t.parent) ? [t.parent.toUpperCase()] : []))]
    .filter(ref => !parents.some(p => p.ref === ref))
  const allParents = [...parents, ...named.map(ref => ({ key: ref, ref, title: '', summary: '' }))]
  const parentOf = (task: { parent?: string | undefined }) => {
    if (!task.parent) return undefined
    return parentKeys.has(task.parent) ? task.parent : allParents.find(p => p.ref === task.parent!.toUpperCase())?.key ?? task.parent
  }
  // Waiting on a parent in this plan is waiting on each of its sub-tasks
  const subTasks = (key: string) => plan.tasks.filter(t => parentOf(t) === key).map(t => t.key)
  return {
    ...plan,
    epics: allParents.map(p => ({ ...p, asParent: true })),
    tasks: plan.tasks.map(({ parent, ...t }) => ({
      ...t,
      epic: parentOf({ parent }),
      humanReview: requiresHumanReview(t.type, t.humanReview ?? false),
      dependsOn: t.dependsOn.flatMap(dep => parentKeys.has(dep) ? subTasks(dep) : [dependency(dep)])
    }))
  }
}
