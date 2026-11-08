import { STOPPED_TASK_STATUSES, type Actor, type RetryStop, type TaskStatus } from '@corral/core'
import { schema, type Database, type Executor, type RunRow, type ProjectRow, type TaskRow } from '@corral/db'
import { and, desc, eq, inArray, isNotNull, isNull, ne, sql } from 'drizzle-orm'
import { publishEpic } from './epics.ts'
import { readAudit } from './audit.ts'
import type { EventBus } from './events.ts'
import { answerDecision, waitingDecision } from './epic-rebase-approval.ts'
import { isTransient, type GitHubClient } from './github.ts'
import { taskBase } from './task-base.ts'
import { applyTransition } from './tasks.ts'
import { addComment, addCommentWithTransition } from './comments.ts'
import { lockTask } from './task-rows.ts'
import { loadTask } from './task-views.ts'

const { auditLog, comments, runs, tasks } = schema

export const REPETITION_REASON = 'Two consecutive failures left the head unchanged without fresh human input or a target change'

// Retry recovery owns a task's stop (its `retryStop`): only the functions
// here write it, and other modules read it through them.

// A no-progress stop leaves the task in its working status with nothing to
// claim it, so it waits on the human once its triage has ended.
export function idleStop(task: Pick<TaskRow, 'status' | 'retryStop' | 'leaseRunId'>): boolean {
  return Boolean(task.retryStop) && !task.leaseRunId && STOPPED_TASK_STATUSES.includes(task.status)
}

// The same as a query: the stopped tasks that nothing else would list
export function idleStopFilter() {
  return and(inArray(tasks.status, [...STOPPED_TASK_STATUSES]), isNull(tasks.leaseRunId), isNotNull(tasks.retryStop))
}

export function stopOf(task: Pick<TaskRow, 'retryStop'>): { runId: string | null, sessionId: string | null } | null {
  return task.retryStop && { runId: task.retryStop.runId, sessionId: task.retryStop.sessionId }
}

// The stop is over: answered, released or no longer repeating
export async function endStop(tx: Executor, taskId: string): Promise<void> {
  await tx.update(tasks).set({ retryStop: null }).where(eq(tasks.id, taskId))
}

export async function startTriage(tx: Executor, task: TaskRow, sessionId: string): Promise<void> {
  await tx.update(tasks).set({ retryStop: { ...task.retryStop!, sessionId } }).where(eq(tasks.id, task.id))
}

// The PM asked the human about the stops it triages here. Only these options
// release them, through answerRecovery.
export async function askRecoveryQuestion(db: Database, sessionId: string, questionId: string, options: string[]): Promise<void> {
  await db.transaction(async (tx) => {
    const stopped = await tx.select().from(tasks).where(sql`${tasks.retryStop}->>'sessionId' = ${sessionId}`).for('update')
    for (const task of stopped) await tx.update(tasks).set({ retryStop: { ...task.retryStop!, retryQuestion: { id: questionId, options } } }).where(eq(tasks.id, task.id))
  })
}

// Only human input resets repetition. Agent notes and triage must not do so.
export async function humanInput(db: Executor, taskId: string): Promise<string> {
  const [comment] = await db.select({ id: comments.id }).from(comments)
    .where(and(eq(comments.taskId, taskId), sql`${comments.author}->>'kind' = 'human'`)).orderBy(desc(comments.createdAt), desc(comments.id)).limit(1)
  const [edit] = await db.select({ id: auditLog.id }).from(auditLog)
    .where(and(eq(auditLog.taskId, taskId), inArray(auditLog.action, ['task.created', 'task.updated', 'task.transition']), sql`${auditLog.actor}->>'kind' = 'human'`)).orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(1)
  return `${comment?.id ?? ''}:${edit?.id ?? ''}`
}

// What a failed run is judged against for repetition: the task's head, its
// target and the latest human input. When GitHub or the database can't answer
// right now, the run keeps the context it had.
export async function retryContext(deps: { db: Executor, github: GitHubClient }, ctx: { task: TaskRow | null, project: ProjectRow | null, run: Pick<RunRow, 'retryContext'> }) {
  if (!ctx.task) return null
  try {
    const base = await taskBase(deps.db, ctx.task, ctx.project!)
    const target = await deps.github.branchHead(ctx.project!.repository, base)
    const head = ctx.task.branch ? (await deps.github.branchHead(ctx.project!.repository, ctx.task.branch) ?? target) : target
    return head && target ? { head, target, human: await humanInput(deps.db, ctx.task.id) } : null
  } catch (error) {
    if (isTransient(error)) return ctx.run.retryContext
    return null
  }
}

// A stop on a task whose triage hasn't been queued yet
function retryStop(runId: string | null, target: string | null, human: string, from: TaskStatus, capped: boolean): RetryStop {
  return { runId, target, human, status: from === 'agent_review' ? 'agent_review' : 'in_progress', capped, sessionId: null }
}

// Called under the task lock, after the failure counter is updated. Transport
// exits never receive a retryContext for counting; only substantive failures do.
export async function stopRepeated(tx: Executor, run: Pick<RunRow, 'id' | 'retryContext'>, from: TaskStatus, task: TaskRow, head: string | null) {
  const context = run.retryContext
  const [previous] = await tx.select().from(runs).where(and(eq(runs.taskId, task.id), ne(runs.role, 'pm'), ne(runs.id, run.id)))
    .orderBy(desc(runs.number)).limit(1)
  const repeated = context && head === context.head && previous?.state === 'failed'
    && previous.headSha === context.head && previous.retryContext?.head === context.head && previous.retryContext.target === context.target && previous.retryContext.human === context.human
  if (!repeated && task.status !== 'failed') return
  await tx.update(tasks).set({ retryStop: retryStop(run.id, context?.target ?? null, context?.human ?? await humanInput(tx, task.id), from, task.status === 'failed') })
    .where(and(eq(tasks.id, task.id), isNull(tasks.retryStop)))
}

export async function triageBlocked(tx: Executor, run: Pick<RunRow, 'id' | 'retryContext'>, task: TaskRow): Promise<void> {
  await tx.update(tasks).set({ retryStop: retryStop(run.id, run.retryContext?.target ?? null, await humanInput(tx, task.id), task.status, false) }).where(eq(tasks.id, task.id))
}

// A cap that isn't a failed run: the transition has just moved the task to
// Failed or Blocked, under its lock. There may be no run to point at.
export async function triageCap(tx: Executor, taskId: string, capped: boolean): Promise<void> {
  const [run] = await tx.select({ id: runs.id }).from(runs).where(and(eq(runs.taskId, taskId), ne(runs.role, 'pm'))).orderBy(desc(runs.number)).limit(1)
  await tx.update(tasks).set({ retryStop: retryStop(run?.id ?? null, null, await humanInput(tx, taskId), 'in_progress', capped) })
    .where(and(eq(tasks.id, taskId), isNull(tasks.retryStop)))
}

// Whether a Blocked task is waiting on a developer's own question, rather than
// a cap, repeated feedback or a decision that's the human's. Only that one the
// PM may answer (D30).
export async function stuckQuestion(db: Executor, taskId: string): Promise<boolean> {
  const [entered] = await db.select({ detail: auditLog.detail }).from(auditLog)
    .where(and(eq(auditLog.taskId, taskId), eq(auditLog.action, 'task.transition'), sql`${auditLog.detail}->>'to' = 'blocked'`))
    .orderBy(desc(auditLog.createdAt)).limit(1)
  return readAudit(entered?.detail).event === 'stuck'
}

// Only an explicitly retry-authorizing choice on a pending question resolves
// a stop. Use D10's human transition and preserve D27's decision journal.
export async function answerRecovery(db: Database, events: EventBus, sessionId: string, text: string, actor: Actor, questionId: string | null): Promise<string[]> {
  if (actor.kind !== 'human' || !questionId) return []
  const stopped = await db.select().from(tasks).where(and(sql`${tasks.retryStop}->>'sessionId' = ${sessionId}`, isNull(tasks.deletedAt)))
  const released: string[] = []
  for (const task of stopped) {
    if (task.retryStop?.retryQuestion?.id !== questionId || !task.retryStop.retryQuestion.options.includes(text.trim())) continue
    const decision = await waitingDecision(db, task.id)
    if (decision) {
      // Exact choice labels retain D27's behaviour-preservation semantics;
      // other written answers conservatively require a fresh human review.
      const alternative = decision.alternatives.findIndex(choice => choice.label === text.trim())
      const epicId = await answerDecision(db, task.id, { action: 'decide', text, ...(alternative >= 0 ? { alternative } : {}) }, actor)
      await publishEpic(db, events, epicId)
    }
    const comment = await db.transaction(async (tx) => {
      const { task: current, project } = await lockTask(tx, task.id)
      if (current.retryStop?.sessionId !== sessionId || current.retryStop.retryQuestion?.id !== questionId || !current.retryStop.retryQuestion.options.includes(text.trim())) return null
      if (current.status === 'blocked' || current.status === 'failed') await applyTransition(tx, current, project, { type: 'resolve', to: 'in_progress' }, actor, { event: { type: 'resolve', to: 'in_progress' } })
      const comment = await addComment(tx, task.id, { body: `Human recovery answer: ${text}`, pinned: true }, actor)
      await endStop(tx, task.id)
      return comment
    })
    if (comment) {
      released.push(task.id)
      events.publish({ type: 'comment.created', comment })
    }
    events.publish({ type: 'task.updated', task: await loadTask(db, task.id) })
  }
  return released
}

// The Inbox's way out of an idle stop (D10 covers Failed and Blocked). Failed
// runs still count, and the human transition starts a fresh repetition streak.
// False when the task has no idle stop, so the caller's usual action applies.
export async function releaseStop(db: Database, taskId: string, actor: Actor, options: { to?: 'backlog' | undefined, comment?: string | undefined }): Promise<boolean> {
  return await db.transaction(async (tx) => {
    const { task, project } = await lockTask(tx, taskId)
    if (!idleStop(task)) return false
    const to = options.to ?? null
    await applyTransition(tx, task, project, { type: 'release_stop', to }, actor, { event: 'release_stop' })
    if (options.comment) await addCommentWithTransition(tx, taskId, { body: options.comment, pinned: true }, actor)
    await endStop(tx, taskId)
    return true
  })
}
