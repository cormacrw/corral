import { TASK_INTEGRATION_PROTOCOL } from '@corral/contracts'
import { schema, type Executor } from '@corral/db'
import { eq, max } from 'drizzle-orm'

const { epics, tasks, taskSubmissions } = schema

// Shared rollout boundary for the PR-free submission handler. Existing PRs
// remain legacy even in epic mode; this never creates or moves an epic branch.
export async function recordTaskSubmission(db: Executor, input: {
  taskId: string
  submittedHeadSha: string
  baseSha: string
}) {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, input.taskId)).for('update')
    if (!task) throw new Error('Task not found')
    const [epic] = task.epicId ? await tx.select().from(epics).where(eq(epics.id, task.epicId)).for('update') : []
    if (task.prNumber !== null || !epic || epic.reviewMode !== 'epic' || !epic.branch
      || !task.branch || task.branch === epic.branch || !['task', 'bug'].includes(task.type)) {
      throw new Error('PR-free submissions require a build task in epic mode with its own branch and no existing task PR. Keep existing PRs, direct, each_task, standalone, spike, design and epic conflict tasks on their existing path.')
    }
    if (!input.submittedHeadSha.trim() || !input.baseSha.trim()) throw new Error('Submission requires head and base commits')
    const [latest] = await tx.select({ sequence: max(taskSubmissions.sequence) }).from(taskSubmissions).where(eq(taskSubmissions.taskId, task.id))
    const [submission] = await tx.insert(taskSubmissions).values({
      taskId: task.id, sequence: (latest?.sequence ?? 0) + 1,
      protocol: TASK_INTEGRATION_PROTOCOL, branch: task.branch,
      submittedHeadSha: input.submittedHeadSha, baseSha: input.baseSha,
      targetBranch: epic.branch
    }).returning()
    await tx.update(tasks).set({ integrationProtocol: TASK_INTEGRATION_PROTOCOL, headSha: input.submittedHeadSha, updatedAt: new Date() }).where(eq(tasks.id, task.id))
    return submission!
  })
}
