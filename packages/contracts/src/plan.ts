import { EPIC_REVIEW_MODES, requiresHumanReview, TASK_PRIORITIES, TASK_TYPES, type ProposedPlan } from '@corral/core'
import { z } from 'zod'

const proposedTask = z.object({
  key: z.string().trim().min(1).describe('A short handle used by dependsOn, e.g. t1'),
  ref: z.string().trim().toUpperCase().optional().transform(ref => ref || undefined).describe('The ref of an existing Backlog or unclaimed Ready task this revises, e.g. COR-4; leave out for a new task'),
  parent: z.string().trim().optional().describe('The key of its parent in parents, or the ref of an existing parent task; leave it out for a task on its own'),
  // Runners from before parent tasks (D31) send `epic`, with keys from `epics`
  epic: z.string().trim().optional().describe('Older name for parent'),
  title: z.string().trim().min(1),
  description: z.string().trim().describe('Markdown: one to three plain sentences a person reads to know what the task is and why. Put the approach, files and edge cases in implementationPlan'),
  implementationPlan: z.string().trim().optional().describe('Markdown for the agent that builds it: approach, file pointers, edge cases and test notes. On a task with a ref, include its current plan (from get_task) to keep it: a revision without one clears it'),
  type: z.enum(TASK_TYPES),
  priority: z.enum(TASK_PRIORITIES).default('medium'),
  humanReview: z.boolean().optional().describe('Leave out on a task with a ref to keep its current setting'),
  acceptanceCriteria: z.array(z.union([z.string().trim(), z.object({ text: z.string().trim(), checkedByHuman: z.boolean().optional() })])).default([]),
  dependsOn: z.array(z.string().trim()).default([]).describe('Keys of tasks in this plan, or refs of existing tasks'),
  // The approved design version a build task builds (D20)
  design: z.object({
    taskRef: z.string().trim().toUpperCase().describe('The design task, e.g. COR-70'),
    version: z.number().int().positive().describe('Its approved version'),
    screens: z.array(z.string().trim()).default([]).describe('Ids of the screens in design.md this task builds')
  }).optional().describe('For a task that builds part of an approved design: the version and the screens it covers')
})

// `parent` is the stored mode `epic`, which older runners still send
const reviewMode = z.enum([...EPIC_REVIEW_MODES, 'parent'], { error: 'reviewMode must be one of parent, each_task, direct' }).optional()
  .transform(mode => mode === 'parent' ? 'epic' as const : mode)

const REVIEW_MODE_HELP = 'How its sub-tasks reach the target branch: parent = human reviews the parent\'s PR; each_task = human also reviews every sub-task; direct = sub-tasks merge straight into the target branch. Leave it out for the project\'s default.'
const parentFields = {
  key: z.string().trim().min(1).describe('A short handle used by a task\'s parent, e.g. p1'),
  ref: z.string().trim().toUpperCase().optional().transform(ref => ref || undefined).describe('An existing parent to add to, or a Draft, Backlog or unclaimed Ready task with no runs to turn into one, e.g. COR-4. It keeps its ref and comments, and its criteria move to its first sub-task. Leave out for a new parent'),
  title: z.string().trim().default('').describe('Required for a new parent'),
  summary: z.string().trim().default(''),
  dependsOn: z.array(z.string().trim()).optional().describe('Parent keys in this plan or refs of existing parents. Omit to keep dependencies in a revision; [] clears them. Sub-tasks wait until these parents are done.')
}

export const proposedPlanInput = z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().default(''),
  parents: z.array(z.object({ ...parentFields, reviewMode: reviewMode.describe(REVIEW_MODE_HELP) })).default([]),
  epics: z.array(z.object({
    key: z.string().trim().min(1).describe('A short handle, e.g. e1'),
    title: z.string().trim(),
    summary: z.string().trim().default(''),
    dependsOn: z.array(z.string().trim()).optional().describe('Keys in this list, or ids from list_tasks. Omit to keep dependencies in a revision; [] clears them.'),
    // The project's default when left out (D27)
    reviewMode: reviewMode.describe('See parents')
  })).default([]).describe('Older name for parents'),
  tasks: z.array(proposedTask),
  // Older PMs proposed a single epic without keys.
  epic: z.object({ title: z.string().trim(), summary: z.string().trim().default('') }).optional()
})

// What the PM is offered: the same plan without the names older runners send
export const advertisedPlanInput = {
  ...proposedPlanInput.omit({ epics: true, epic: true, parents: true }).shape,
  parents: z.array(z.object({ ...parentFields, reviewMode: z.enum(['parent', 'each_task', 'direct'], { error: 'reviewMode must be one of parent, each_task, direct' }).optional().describe(REVIEW_MODE_HELP) })).default([]),
  tasks: z.array(proposedTask.omit({ epic: true }))
}

const REF = /^([A-Za-z]+)-(\d+)$/

// Keep wire compatibility and normalization at the boundary, outside core.
export function normalizeProposedPlan(input: z.output<typeof proposedPlanInput>): ProposedPlan {
  const { epic, parents, ...plan } = input
  const legacyEpic = epic && plan.epics.length === 0
  const keys = new Set(plan.tasks.map(t => t.key))
  const dependency = (dep: string) => keys.has(dep) || !REF.test(dep) ? dep : dep.toUpperCase()
  const parentKeys = new Set(parents.map(p => p.key))
  // A parent named only by its ref on a task
  const named = [...new Set(plan.tasks.flatMap(t => t.parent && !parentKeys.has(t.parent) && REF.test(t.parent) ? [t.parent.toUpperCase()] : []))]
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
    epics: [...legacyEpic ? [{ key: 'main', ...epic }] : plan.epics, ...allParents.map(p => ({ ...p, asParent: true }))],
    tasks: plan.tasks.map(({ parent, ...t }) => ({
      ...t,
      epic: parentOf({ parent }) || t.epic || (legacyEpic ? 'main' : undefined),
      humanReview: requiresHumanReview(t.type, t.humanReview ?? false),
      dependsOn: t.dependsOn.flatMap(dep => parentKeys.has(dep) ? subTasks(dep) : [dependency(dep)])
    }))
  }
}
