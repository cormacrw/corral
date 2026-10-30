import { schema, type Executor } from '@corral/db'
import { eq } from 'drizzle-orm'
import type { GitHubClient } from './github.ts'
import { slugify } from './projects.ts'
import type { ProjectRow, TaskRow } from './tasks.ts'

export class EpicBranchError extends Error {}

// Resolve at every boundary so jobs, prompts, PRs and conflicts agree.
// Supplying GitHub prepares the base before the first developer assignment.
export async function taskBase(db: Executor, task: TaskRow, project: ProjectRow, github?: GitHubClient): Promise<string> {
  if (!task.epicId || task.type === 'spike' || task.type === 'design') return project.defaultBranch
  const [epic] = await db.select().from(schema.epics).where(eq(schema.epics.id, task.epicId))
  if (!epic || epic.reviewMode === 'direct') return project.defaultBranch
  const branch = epic.branch ?? `corral/epic-${epic.id}-${slugify(epic.title).slice(0, 40).replace(/-+$/, '')}`
  if (github) {
    try {
      if (!await github.branchHead(project.repository, branch)) {
        const sha = await github.branchHead(project.repository, project.defaultBranch)
        if (!sha) throw new Error(`target branch ${project.defaultBranch} does not exist`)
        await github.createBranch(project.repository, branch, sha)
      }
    } catch (error) {
      throw new EpicBranchError(`Could not prepare epic branch ${branch}: ${error instanceof Error ? error.message : String(error)}`)
    }
    if (!epic.branch) await db.update(schema.epics).set({ branch }).where(eq(schema.epics.id, epic.id))
  }
  return branch
}
