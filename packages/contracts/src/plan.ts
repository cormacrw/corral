import { EPIC_REVIEW_MODES, requiresHumanReview, TASK_PRIORITIES, TASK_TYPES, type ProposedPlan } from '@corral/core'
import { z } from 'zod'

const proposedTask = z.object({
  key: z.string().trim().min(1).describe('A short handle used by dependsOn, e.g. t1'),
  ref: z.string().trim().toUpperCase().optional().transform(ref => ref || undefined).describe('The ref of an existing Backlog task this revises, e.g. COR-4; leave out for a new task'),
  epic: z.string().trim().optional().describe('The key of its epic in epics; leave it out for a task with no epic'),
  title: z.string().trim().min(1),
  description: z.string().trim(),
  type: z.enum(TASK_TYPES),
  priority: z.enum(TASK_PRIORITIES).default('medium'),
  humanReview: z.boolean().default(false),
  acceptanceCriteria: z.array(z.string().trim()).default([]),
  dependsOn: z.array(z.string().trim()).default([]).describe('Keys of tasks in this plan, or refs of existing tasks'),
  // The approved design version a build task builds (D20)
  design: z.object({
    taskRef: z.string().trim().toUpperCase().describe('The design task, e.g. COR-70'),
    version: z.number().int().positive().describe('Its approved version'),
    screens: z.array(z.string().trim()).default([]).describe('Ids of the screens in design.md this task builds')
  }).optional().describe('For a task that builds part of an approved design: the version and the screens it covers')
})

export const proposedPlanInput = z.object({
  title: z.string().trim().min(1),
  summary: z.string().trim().default(''),
  epics: z.array(z.object({
    key: z.string().trim().min(1).describe('A short handle used by a task\'s epic, e.g. e1'),
    title: z.string().trim(),
    summary: z.string().trim().default(''),
    dependsOn: z.array(z.string().trim()).optional().describe('Epic keys in this plan or existing epic ids from list_tasks. Omit to keep dependencies in a revision; [] clears them. Tasks wait until prerequisite epics are done.'),
    // The project's default when left out (D23)
    reviewMode: z.enum(EPIC_REVIEW_MODES, { error: `reviewMode must be one of ${EPIC_REVIEW_MODES.join(', ')}` }).optional().describe('How its tasks reach the target branch: epic = human reviews the epic PR; each_task = human also reviews every task; direct = tasks merge straight into the target branch. Leave it out for the project\'s default.')
  })).default([]),
  tasks: z.array(proposedTask),
  // Older PMs proposed a single epic without keys.
  epic: z.object({ title: z.string().trim(), summary: z.string().trim().default('') }).optional()
})

const REF = /^([A-Za-z]+)-(\d+)$/

// Keep wire compatibility and normalization at the boundary, outside core.
export function normalizeProposedPlan(input: z.output<typeof proposedPlanInput>): ProposedPlan {
  const { epic, ...plan } = input
  const legacyEpic = epic && plan.epics.length === 0
  const keys = new Set(plan.tasks.map(t => t.key))
  const dependency = (dep: string) => keys.has(dep) || !REF.test(dep) ? dep : dep.toUpperCase()
  return {
    ...plan,
    epics: legacyEpic ? [{ key: 'main', ...epic }] : plan.epics,
    tasks: plan.tasks.map(t => ({
      ...t,
      epic: t.epic || (legacyEpic ? 'main' : undefined),
      humanReview: requiresHumanReview(t.type, t.humanReview),
      dependsOn: t.dependsOn.map(dependency)
    }))
  }
}
