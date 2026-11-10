import { SERVER_ACTOR } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, eq, inArray, isNotNull } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import type { GitHubClient } from './github.ts'
import { ensureParent } from './parents.ts'
import { allocateTaskNumber } from './projects.ts'
import { epicResolutionBranch } from './task-base.ts'

const { acceptanceCriteria, agents, epics, projects, taskIntegrationOperations: operations, tasks } = schema

// Turns each epic fix waiting on a conflict into the resolution task a server
// from before D29 would have made, for proving those still finish. Ready on
// the board, like Corral's own fix tasks, without resetting the epic's review.
export async function asResolutionTasks(db: Executor, github: GitHubClient): Promise<void> {
  const open = await db.select({ operation: operations, epic: epics, project: projects }).from(operations)
    .innerJoin(epics, eq(epics.id, operations.epicId)).innerJoin(projects, eq(projects.id, epics.projectId))
    .where(and(isNotNull(operations.fix), eq(operations.fix, 'conflict'), eq(operations.state, 'running')))
  for (const { operation, epic, project } of open) {
    const branch = epicResolutionBranch(operation.id)
    await github.createBranch(project.repository, branch, operation.expectedTargetSha)
    const id = await db.transaction(async (tx) => {
      const number = await allocateTaskNumber(tx, project.id)
      const [task] = await tx.insert(tasks).values({
        projectId: project.id, number, title: `Rebase epic: ${epic.title}`, type: 'task', priority: 'medium', epicId: epic.id,
        status: 'ready', humanReview: project.humanReviewDefault, branch, createdBy: SERVER_ACTOR
      }).returning({ id: tasks.id })
      await tx.insert(acceptanceCriteria).values({ taskId: task!.id, position: 0, text: `${branch} is rebased` })
      await appendAudit(tx, { projectId: project.id, taskId: task!.id, actor: SERVER_ACTOR }, auditEvent('task.created', { number }))
      await ensureParent(tx, epic.id, SERVER_ACTOR)
      return task!.id
    })
    await db.update(operations).set({ resolutionTaskId: id, fix: null, fixBrief: null }).where(eq(operations.id, operation.id))
  }
}

// A pass on a server from before D29, which had no fix runs: developers are
// held back until each conflict it finds is a resolution task
export async function passBeforeD29(db: Executor, github: GitHubClient, pass: () => Promise<unknown>): Promise<void> {
  const held = await db.update(agents).set({ paused: true }).where(and(eq(agents.role, 'developer'), eq(agents.paused, false))).returning({ id: agents.id })
  try {
    await pass()
    await asResolutionTasks(db, github)
  } finally {
    if (held.length) await db.update(agents).set({ paused: false }).where(inArray(agents.id, held.map(a => a.id)))
  }
}
