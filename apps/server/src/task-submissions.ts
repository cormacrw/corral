import { TASK_INTEGRATION_PROTOCOL } from '@corral/contracts'
import { schema, type Executor } from '@corral/db'
import { asc, eq, max } from 'drizzle-orm'
import { isEpicResolution } from './task-base.ts'

const { epics, tasks, taskSubmissions } = schema

type TaskFacts = Pick<typeof tasks.$inferSelect, 'prNumber' | 'branch' | 'type'>
type EpicFacts = Pick<typeof epics.$inferSelect, 'reviewMode' | 'branch' | 'reviewState'>

// D27's explicit rollout boundary. An epic whose PR merged is over: tasks added
// after it take a PR to the target branch (taskBase).
function prFreeEligible(task: TaskFacts, epic: EpicFacts | undefined): epic is EpicFacts & { branch: string } {
  return task.prNumber === null && epic?.reviewMode === 'epic' && epic.reviewState !== 'merged' && !!epic.branch
    && !!task.branch && task.branch !== epic.branch && !isEpicResolution(task) && ['task', 'bug'].includes(task.type)
}

// Persists the PR-free path for a task whose developer run is going to a runner
// that supports it; a legacy runner's run stays on the task-PR path. Selection
// is permanent, so every later run needs a supporting runner too.
export async function selectPrFreeProtocol(db: Executor, taskId: string) {
  return db.transaction(async (tx) => {
    const [task] = await tx.select().from(tasks).where(eq(tasks.id, taskId)).for('update')
    if (!task) throw new Error('Task not found')
    const [epic] = task.epicId ? await tx.select().from(epics).where(eq(epics.id, task.epicId)).for('update') : []
    if (!prFreeEligible(task, epic)) return task
    const [selected] = await tx.update(tasks).set({ integrationProtocol: TASK_INTEGRATION_PROTOCOL }).where(eq(tasks.id, taskId)).returning()
    return selected!
  })
}

// Oldest first; each revision adds a row and earlier ones are never rewritten
export async function listTaskSubmissions(db: Executor, taskId: string) {
  return db.select().from(taskSubmissions).where(eq(taskSubmissions.taskId, taskId)).orderBy(asc(taskSubmissions.sequence))
}

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
    if (!prFreeEligible(task, epic)) {
      throw new Error('PR-free submissions require a build task in epic mode with its own branch and no existing task PR. Keep existing PRs, direct, each_task, standalone, spike, design and epic conflict tasks on their existing path.')
    }
    if (!input.submittedHeadSha.trim() || !input.baseSha.trim()) throw new Error('Submission requires head and base commits')
    const [latest] = await tx.select({ sequence: max(taskSubmissions.sequence) }).from(taskSubmissions).where(eq(taskSubmissions.taskId, task.id))
    const [submission] = await tx.insert(taskSubmissions).values({
      taskId: task.id, sequence: (latest?.sequence ?? 0) + 1,
      protocol: TASK_INTEGRATION_PROTOCOL, branch: task.branch!,
      submittedHeadSha: input.submittedHeadSha, baseSha: input.baseSha,
      targetBranch: epic.branch
    }).returning()
    await tx.update(tasks).set({ integrationProtocol: TASK_INTEGRATION_PROTOCOL, headSha: input.submittedHeadSha, updatedAt: new Date() }).where(eq(tasks.id, task.id))
    return submission!
  })
}
