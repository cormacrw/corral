import { COMMIT_OUTCOMES, deliversCode, errorText } from '@corral/core'
import { schema, type Executor, type ProjectRow, type TaskRow } from '@corral/db'
import { and, desc, eq, inArray } from 'drizzle-orm'
import { MAX_CI_FIXES } from './retries.ts'
import type { GitHubClient } from './github.ts'
import { branchSlug } from './projects.ts'
import { taskCriteria } from './criteria.ts'

const CODE_SUBMISSIONS = COMMIT_OUTCOMES.filter(outcome => outcome !== 'design_submitted')

// Submissions in a row, newest back, that were CI fixes. Any other submission
// ends the count, and a human's Retry leads to one.
export async function ciFixesInARow(db: Executor, taskId: string): Promise<number> {
  const rows = await db.select({ fixKind: schema.runs.fixKind }).from(schema.runs)
    .where(and(eq(schema.runs.taskId, taskId), eq(schema.runs.role, 'developer'), eq(schema.runs.state, 'completed'), inArray(schema.runs.outcome, CODE_SUBMISSIONS)))
    .orderBy(desc(schema.runs.number)).limit(MAX_CI_FIXES)
  const other = rows.findIndex(row => row.fixKind !== 'ci')
  return other === -1 ? rows.length : other
}

// isTransient judges it by its cause
export class EpicBranchError extends Error {}

// A task's criteria and this round's evidence, and the agent-checkable
// criteria with none yet (D21, D28)
export async function evidenceState(db: Executor, task: { id: string, reviewRounds: number }) {
  const criteria = await taskCriteria(db, task.id)
  const attached = await db.select({ criterionId: schema.evidence.criterionId }).from(schema.evidence)
    .where(and(eq(schema.evidence.taskId, task.id), eq(schema.evidence.round, task.reviewRounds)))
  return { criteria, attached, missing: criteria.filter(c => !c.checkedByHuman && !attached.some(e => e.criterionId === c.id)) }
}

// A fix of the epic branch works on a candidate branch of its own, which only
// reaches the epic branch once Corral publishes it (D29)
export const epicResolutionBranch = (operationId: string) => `corral/epic-rebase/${operationId}`

// Resolve at every boundary so jobs, prompts, PRs and conflicts agree.
// Supplying GitHub prepares the base before the first developer assignment.
export async function taskBase(db: Executor, task: TaskRow, project: ProjectRow, github?: GitHubClient): Promise<string> {
  if (!task.epicId || !deliversCode(task.type)) return project.defaultBranch
  const [epic] = await db.select().from(schema.epics).where(eq(schema.epics.id, task.epicId))
  if (!epic || epic.reviewMode === 'direct' || epic.reviewState === 'merged') return project.defaultBranch
  const branch = epic.branch ?? `corral/epic-${epic.id}-${branchSlug(epic.title)}`
  if (github) {
    try {
      if (!await github.branchHead(project.repository, branch)) {
        const sha = await github.branchHead(project.repository, project.defaultBranch)
        if (!sha) throw new Error(`target branch ${project.defaultBranch} does not exist`)
        await github.createBranch(project.repository, branch, sha)
      }
    } catch (error) {
      throw new EpicBranchError(`Could not prepare epic branch ${branch}: ${errorText(error)}`, { cause: error })
    }
    if (!epic.branch) await db.update(schema.epics).set({ branch }).where(eq(schema.epics.id, epic.id))
  }
  return branch
}
