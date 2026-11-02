import { schema, type Executor } from '@corral/db'
import { eq, isNotNull, and, inArray } from 'drizzle-orm'
import type { GitHubClient } from './github.ts'
import { epicResolutionBranch } from './task-base.ts'
import { createTask, type ProjectRow } from './tasks.ts'

const { epics, projects, taskIntegrationOperations: operations, tasks } = schema
const server = { kind: 'system', component: 'server' } as const

// Turns each epic fix waiting on a conflict into the resolution task a server
// from before D29 would have made, for proving those still finish
export async function asResolutionTasks(db: Executor, github: GitHubClient): Promise<void> {
  const open = await db.select({ operation: operations, epic: epics, project: projects }).from(operations)
    .innerJoin(epics, eq(epics.id, operations.epicId)).innerJoin(projects, eq(projects.id, epics.projectId))
    .where(and(isNotNull(operations.fix), eq(operations.fix, 'conflict'), inArray(operations.state, ['running'])))
  for (const { operation, epic, project } of open) {
    const branch = epicResolutionBranch(operation.id)
    await github.createBranch(project.repository, branch, operation.expectedTargetSha)
    const id = await createTask(db, project as ProjectRow, { type: 'task', title: `Rebase epic: ${epic.title}`, epicId: epic.id, acceptanceCriteria: [`${branch} is rebased`] }, server, { epicFix: true, keepEpicReview: true })
    await db.update(tasks).set({ branch }).where(eq(tasks.id, id))
    await db.update(operations).set({ resolutionTaskId: id, fix: null, fixBrief: null }).where(eq(operations.id, operation.id))
  }
}
