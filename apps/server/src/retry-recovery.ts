import type { PmRunJob } from '@corral/contracts'
import { taskRef, type Actor } from '@corral/core'
import { schema, type Database, type Executor } from '@corral/db'
import { and, asc, desc, eq, inArray, isNull, ne, isNotNull, sql } from 'drizzle-orm'
import { getEpic } from './epics.ts'
import type { EventBus } from './events.ts'
import { answerDecision, waitingDecision } from './epic-rebase-approval.ts'
import type { Backoff } from './retries.ts'
import { pmPrompt } from './prompts.ts'
import { server, type RunContext, type RunCore } from './run-context.ts'
import { taskBase } from './task-base.ts'
import { addComment, applyTransition, lockTask, loadTask, type TaskRow } from './tasks.ts'

const { agents, auditLog, comments, planSessions, projects, runs, tasks } = schema

export const REPETITION_REASON = 'Two consecutive failures left the head unchanged without fresh human input or a target change'

// A no-progress stop leaves the task in its working status with nothing to
// claim it, so it waits on the human once its triage has ended.
export function idleStop(task: Pick<TaskRow, 'status' | 'retryStop' | 'leaseRunId'>): boolean {
  return Boolean(task.retryStop?.sessionId) && !task.leaseRunId && (task.status === 'in_progress' || task.status === 'agent_review')
}

// Only human input resets repetition. Agent notes and triage must not do so.
export async function humanInput(db: Executor, taskId: string): Promise<string> {
  const [comment] = await db.select({ id: comments.id }).from(comments)
    .where(and(eq(comments.taskId, taskId), sql`${comments.author}->>'kind' = 'human'`)).orderBy(desc(comments.createdAt), desc(comments.id)).limit(1)
  const [edit] = await db.select({ id: auditLog.id }).from(auditLog)
    .where(and(eq(auditLog.taskId, taskId), inArray(auditLog.action, ['task.created', 'task.updated', 'task.transition']), sql`${auditLog.actor}->>'kind' = 'human'`)).orderBy(desc(auditLog.createdAt), desc(auditLog.id)).limit(1)
  return `${comment?.id ?? ''}:${edit?.id ?? ''}`
}

export async function retryContext(c: RunCore, ctx: RunContext) {
  if (!ctx.task) return null
  const base = await taskBase(c.d.db, ctx.task, ctx.project)
  const target = await c.d.github.branchHead(ctx.project.repository, base)
  const head = ctx.task.branch ? (await c.d.github.branchHead(ctx.project.repository, ctx.task.branch) ?? target) : target
  return head && target ? { head, target, human: await humanInput(c.d.db, ctx.task.id) } : null
}

// Called under the task lock, after the failure counter is updated. Transport
// exits never receive a retryContext for counting; only substantive failures do.
export async function stopRepeated(tx: Executor, ctx: RunContext, task: TaskRow, head: string | null) {
  const context = ctx.run.retryContext
  const [previous] = await tx.select().from(runs).where(and(eq(runs.taskId, task.id), ne(runs.role, 'pm'), ne(runs.id, ctx.run.id)))
    .orderBy(desc(runs.number)).limit(1)
  const repeated = context && head === context.head && previous?.state === 'failed'
    && previous.headSha === context.head && previous.retryContext?.head === context.head && previous.retryContext.target === context.target && previous.retryContext.human === context.human
  if (!repeated && task.status !== 'failed') return
  await tx.update(tasks).set({ retryStop: {
    runId: ctx.run.id, target: context?.target ?? null, human: context?.human ?? await humanInput(tx, task.id),
    status: ctx.task?.status === 'agent_review' ? 'agent_review' : 'in_progress', capped: task.status === 'failed', sessionId: null
  } }).where(and(eq(tasks.id, task.id), isNull(tasks.retryStop)))
}

export async function triageBlocked(tx: Executor, ctx: RunContext, task: TaskRow): Promise<void> {
  await tx.update(tasks).set({ retryStop: { runId: ctx.run.id, target: ctx.run.retryContext?.target ?? null,
    human: await humanInput(tx, task.id), status: task.status === 'agent_review' ? 'agent_review' : 'in_progress', capped: false, sessionId: null } }).where(eq(tasks.id, task.id))
}

export function triagePrompt(ref: string, reason: string): string {
  return `Automatic recovery for ${ref} stopped: ${reason}. This is its one PM triage turn for this stop. Read get_task, list_runs and get_run for its failures, then inspect the relevant code and project docs. Resolve implementation problems yourself: propose concrete follow-up work with propose_plan or leave actionable findings with add_comment on ${ref}. Do not ask the human to debug or decide implementation details. Do not approve a plan, reset counters, or restart unchanged work. Only ask_question if requirements, authority or a recovery decision genuinely require the human. State what is blocked, what recovery was tried and why it stopped, the decision needed, and a recommendation (or why none is safe). Keep the recommendation in ask_question's recommendation field. Leave a comment on ${ref} linking your findings or proposal. For a recovery question, set retryOptions to only the exact answer choices (or recommendation) that authorize retrying or continuing work. Never include leaving stopped, refusal, or clarification in retryOptions. Human plan approval still applies.`
}

// Durable stop episodes and queued PM jobs survive restarts. The task lock
// makes creation exactly once even when scheduler passes race.
export async function reconcileRecovery(c: RunCore, targetPoll: Backoff): Promise<void> {
  const { db, events } = c.d
  // New stop markers only: deploying must not replay historical Failed tasks.
  const stopped = await db.select({ task: tasks, project: projects }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
    .where(and(isNull(tasks.deletedAt), isNotNull(tasks.retryStop)))
  for (const { task, project } of stopped) {
    const stop = task.retryStop
    if (stop?.sessionId) {
      const human = await humanInput(db, task.id)
      let target: string | null = null
      if (human === stop.human && c.d.runner.online && !stop.capped && task.status !== 'blocked' && stop.target && targetPoll.due(task.id)) {
        targetPoll.later(task.id)
        try {
          target = await c.d.github.branchHead(project.repository, await taskBase(db, task, project))
        } catch { /* An unavailable target is not evidence of change. */ }
      }
      if (!stop.capped && task.status !== 'blocked' && (human !== stop.human || (target && target !== stop.target))) {
        await db.transaction(async (tx) => {
          const { task: current } = await lockTask(tx, task.id)
          if (current.retryStop?.runId === stop.runId && !current.leaseRunId) await tx.update(tasks).set({ retryStop: null }).where(eq(tasks.id, task.id))
        })
        targetPoll.clear(task.id)
        events.publish({ type: 'task.updated', task: await loadTask(db, task.id) })
        continue
      }
      // A human explicitly resolved a capped task through D10.
      if ((stop.capped && task.status !== 'failed') || (!stop.capped && task.status !== 'blocked' && task.status !== stop.status)) {
        await db.update(tasks).set({ retryStop: null }).where(eq(tasks.id, task.id))
        targetPoll.clear(task.id)
        continue
      }
      if (stop.sessionId) continue
    }
    const queued = await db.transaction(async (tx) => {
      const { task: locked } = await lockTask(tx, task.id)
      if (!locked.retryStop || locked.retryStop.sessionId || locked.leaseRunId) return null
      const [pm] = await tx.select().from(agents).where(eq(agents.role, 'pm')).orderBy(asc(agents.createdAt)).limit(1)
      if (!pm) return null
      const ref = taskRef(project.prefix, task.number)
      const reason = locked.statusReason ?? REPETITION_REASON
      const [session] = await tx.insert(planSessions).values({ projectId: project.id, title: `Recovery: ${ref}`, runtime: pm.runtime, createdBy: server }).returning()
      const job: Omit<PmRunJob, 'runId' | 'runNumber' | 'leaseEpoch'> = {
        role: 'pm', runtime: pm.runtime, projectId: project.id, repository: project.repository, defaultBranch: project.defaultBranch,
        taskId: null, taskRef: null, branch: null, headSha: null, planSessionId: session!.id, agentSessionId: null,
        fallbackPrompt: null, model: null, timeoutSeconds: 20 * 60,
        prompt: pmPrompt({ fresh: true, text: triagePrompt(ref, reason), attachedTask: ref, projectName: project.name, prefix: project.prefix })
      }
      const [run] = await tx.insert(runs).values({ agentId: pm.id, projectId: project.id, taskId: task.id, role: 'pm', leaseEpoch: 1, planSessionId: session!.id, pmJob: job, queuedAt: c.now() }).returning()
      await tx.update(tasks).set({ retryStop: { ...locked.retryStop, sessionId: session!.id } }).where(eq(tasks.id, task.id))
      const comment = await addComment(tx, task.id, { body: `${reason}. PM triage queued as run #${run!.number}. [Recovery conversation](/plan/${session!.id})`, pinned: false }, server)
      return { run: run!, comment }
    })
    if (queued) {
      events.publish({ type: 'comment.created', comment: queued.comment })
      const ctx = await c.runs.load(queued.run.id)
      if (ctx) await c.ending.publish(ctx)
      if (c.plans) events.publish({ type: 'plan.session', session: await c.plans.getSession(queued.run.planSessionId!) })
    }
  }
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
      events.publish({ type: 'epic.updated', epic: await getEpic(db, epicId) })
    }
    const comment = await db.transaction(async (tx) => {
      const { task: current, project } = await lockTask(tx, task.id)
      if (current.retryStop?.sessionId !== sessionId || current.retryStop.retryQuestion?.id !== questionId || !current.retryStop.retryQuestion.options.includes(text.trim())) return null
      if (current.status === 'blocked' || current.status === 'failed') await applyTransition(tx, current, project, { type: 'resolve', to: 'in_progress' }, actor, { event: { type: 'resolve', to: 'in_progress' } })
      const comment = await addComment(tx, task.id, { body: `Human recovery answer: ${text}`, pinned: true }, actor)
      await tx.update(tasks).set({ retryStop: null }).where(eq(tasks.id, task.id))
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
    if (options.comment) await tx.insert(comments).values({ taskId, author: actor, body: options.comment, pinned: true })
    await tx.update(tasks).set({ retryStop: null }).where(eq(tasks.id, taskId))
    return true
  })
}
