import { schema, type Executor } from '@corral/db'
import { and, asc, desc, eq, inArray } from 'drizzle-orm'
import { MAX_CI_FIXES } from './ci-output.ts'
import { isTransient, type GitHubClient } from './github.ts'
import { slugify } from './projects.ts'
import type { ProjectRow, TaskRow } from './tasks.ts'

// Submissions in a row, newest back, that were CI fixes. Any other submission
// ends the count, and a human's Retry leads to one.
export async function ciFixesInARow(db: Executor, taskId: string): Promise<number> {
  const rows = await db.select({ fixKind: schema.runs.fixKind }).from(schema.runs)
    .where(and(eq(schema.runs.taskId, taskId), eq(schema.runs.role, 'developer'), eq(schema.runs.state, 'completed'), inArray(schema.runs.outcome, ['pr_opened', 'pr_updated', 'pr_rebased', 'commit_submitted'])))
    .orderBy(desc(schema.runs.number)).limit(MAX_CI_FIXES)
  const other = rows.findIndex(row => row.fixKind !== 'ci')
  return other === -1 ? rows.length : other
}

export class EpicBranchError extends Error {
  // Whether trying again later may work (see isTransient in github.ts)
  readonly transient: boolean
  constructor(message: string, transient: boolean) {
    super(message)
    this.transient = transient
  }
}

// A task's criteria and this round's evidence, and the agent-checkable
// criteria with none yet (D21, D28)
export async function evidenceState(db: Executor, task: { id: string, reviewRounds: number }) {
  const criteria = await db.select().from(schema.acceptanceCriteria).where(eq(schema.acceptanceCriteria.taskId, task.id)).orderBy(asc(schema.acceptanceCriteria.position))
  const attached = await db.select({ criterionId: schema.evidence.criterionId }).from(schema.evidence)
    .where(and(eq(schema.evidence.taskId, task.id), eq(schema.evidence.round, task.reviewRounds)))
  return { criteria, attached, missing: criteria.filter(c => !c.checkedByHuman && !attached.some(e => e.criterionId === c.id)) }
}

// A conflict from an epic rebase is resolved on a candidate branch of its own,
// which only reaches the epic branch once approved (D27)
const RESOLUTION_PREFIX = 'corral/epic-rebase/'
export const epicResolutionBranch = (operationId: string) => `${RESOLUTION_PREFIX}${operationId}`
export const isEpicResolution = (task: { branch: string | null }) => task.branch?.startsWith(RESOLUTION_PREFIX) ?? false

// Whether a task repairs the epic rather than adding to it: it opens no PR of
// its own. Besides resolutions, that's a task handed an epic PR's rebase before
// they existed, whose branch is the epic branch.
export async function isEpicRebaseTask(db: Executor, task: TaskRow): Promise<boolean> {
  if (!task.epicId || !task.branch) return false
  if (isEpicResolution(task)) return true
  const [epic] = await db.select({ branch: schema.epics.branch }).from(schema.epics).where(eq(schema.epics.id, task.epicId))
  return epic?.branch === task.branch
}

// Resolve at every boundary so jobs, prompts, PRs and conflicts agree.
// Supplying GitHub prepares the base before the first developer assignment.
export async function taskBase(db: Executor, task: TaskRow, project: ProjectRow, github?: GitHubClient): Promise<string> {
  if (!task.epicId || task.type === 'spike' || task.type === 'design') return project.defaultBranch
  const [epic] = await db.select().from(schema.epics).where(eq(schema.epics.id, task.epicId))
  if (!epic || epic.reviewMode === 'direct' || epic.reviewState === 'merged') return project.defaultBranch
  // A rebase task works on the epic's commits, against the target branch
  if (isEpicResolution(task) || (epic.branch && task.branch === epic.branch)) return project.defaultBranch
  const branch = epic.branch ?? `corral/epic-${epic.id}-${slugify(epic.title).slice(0, 40).replace(/-+$/, '')}`
  if (github) {
    try {
      if (!await github.branchHead(project.repository, branch)) {
        const sha = await github.branchHead(project.repository, project.defaultBranch)
        if (!sha) throw new Error(`target branch ${project.defaultBranch} does not exist`)
        await github.createBranch(project.repository, branch, sha)
      }
    } catch (error) {
      throw new EpicBranchError(`Could not prepare epic branch ${branch}: ${error instanceof Error ? error.message : String(error)}`, isTransient(error))
    }
    if (!epic.branch) await db.update(schema.epics).set({ branch }).where(eq(schema.epics.id, epic.id))
  }
  return branch
}
