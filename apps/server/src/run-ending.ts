import type { Comment, RunEvent } from '@corral/contracts'
import { ACTIVE_RUN_STATES } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, count, eq, inArray, isNotNull } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { publishDependents } from './dependent-tasks.ts'
import { runEndValues, type RunEnd } from './run-lifecycle.ts'
import { getRun } from './runs.ts'
import { addComment, applyTransition, loadTask, lockTask } from './tasks.ts'
import { server, type RunContext, type RunCore } from './run-context.ts'

const { runs, tasks } = schema

// A PM turn's reply is the last thing it said (D9)
export function lastPmReply(events: RunEvent[]): string | null {
  return events.filter((e): e is Extract<RunEvent, { type: 'message' }> => e.type === 'message').at(-1)?.text ?? null
}

export class RunEnding {
  #c: RunCore

  constructor(core: RunCore) {
    this.#c = core
  }

  // A line in the run's transcript from Corral itself
  async note(runId: string, text: string): Promise<void> {
    const events: RunEvent[] = [{ type: 'system', text }]
    const offset = await this.#c.d.transcripts.append(runId, events)
    this.#c.d.events.publish({ type: 'run.events', runId, offset, events })
  }

  // A failed run counts towards the failed-run cap (D10); at the cap the task fails
  async failRun(ctx: RunContext, error: string, fields: Partial<typeof runs.$inferInsert> = {}, note?: string): Promise<void> {
    let reviewHandedOver = false
    const comment = await this.#c.d.db.transaction(async (tx) => {
      const comment = note && ctx.task ? await this.postNote(tx, ctx, note) : null
      if (ctx.task) {
        const { task, project } = await lockTask(tx, ctx.task.id)
        if (task.leaseRunId === ctx.run.id && ['in_progress', 'agent_review'].includes(task.status)) {
          await applyTransition(tx, task, project, { type: 'run_failed' }, server, { event: 'run_failed', runId: ctx.run.id, error })
        }
      }
      if (ctx.run.epicId) reviewHandedOver = await this.#c.epicPrs.reviewFailed(tx, ctx.run, error)
      await this.endRunIn(tx, ctx, { ...fields, state: 'failed', outcome: 'failed', error })
      return comment
    })
    if (comment) this.#c.d.events.publish({ type: 'comment.created', comment })
    if (reviewHandedOver) await this.#c.epicPrs.publish(ctx.run.epicId!)
  }

  // The developer's work note: what this run did, as a comment by its agent,
  // so the task's history shows the developer's turns between reviews
  async postNote(tx: Executor, ctx: RunContext, note: string): Promise<Comment> {
    return addComment(tx, ctx.task!.id, { body: note, pinned: false }, this.#c.runs.actor(ctx))
  }

  async endRun(ctx: RunContext, end: RunEnd): Promise<boolean> {
    return this.#c.d.db.transaction(tx => this.endRunIn(tx, ctx, end))
  }

  // Ends the run and releases its lease, if it still holds one. Whether this
  // ended it: an outcome accepted since `ctx` was read stands, and isn't
  // overwritten or audited twice.
  async endRunIn(tx: Executor, ctx: RunContext, end: RunEnd): Promise<boolean> {
    const [ended] = await tx.update(runs).set(runEndValues(end, this.#c.now()))
      .where(and(eq(runs.id, ctx.run.id), inArray(runs.state, [...ACTIVE_RUN_STATES]))).returning({ id: runs.id })
    if (ctx.task) {
      await tx.update(tasks).set({ leaseRunId: null, leaseRole: null, leaseExpiresAt: null, leaseHeartbeatAt: null, updatedAt: this.#c.now() })
        .where(and(eq(tasks.id, ctx.task.id), eq(tasks.leaseRunId, ctx.run.id)))
    }
    if (ended) await appendAudit(tx, { projectId: ctx.project.id, taskId: ctx.task?.id ?? null, actor: server }, auditEvent('run.ended', { runId: ctx.run.id, runNumber: ctx.run.number, state: end.state, outcome: end.outcome ?? null, error: 'error' in end ? end.error : null, ...(end.outcome === 'pr_rebased' ? { review: end.review, conflictedFiles: end.conflictedFiles } : {}) }))
    return ended !== undefined
  }

  // The server ends a run the agent didn't finish, on every path but a human's
  // stop (the Plan thread's close handles its own). Its run.ended won't count
  // any more, so a PM turn's session hears now: whatever it said, or why not.
  async interrupted(ctx: RunContext, error: string): Promise<void> {
    if (!await this.endRun(ctx, { state: 'interrupted', error })) return
    if (ctx.run.role !== 'pm' || !ctx.run.planSessionId) return
    await this.#c.plans?.onRunEnded(ctx.run.planSessionId, ctx.run.id, lastPmReply(await this.#c.d.transcripts.read(ctx.run.id, null)), error)
  }

  // The outcome is recorded; the runner stops the agent's process tree. A
  // handoff (a pushed PR, a verdict) lets the next agent start the task now.
  finished(ctx: RunContext, reason: string, { handoff = false } = {}): void {
    this.#c.d.runner.send({ type: 'run.stop', runId: ctx.run.id, reason }, ctx.run.runnerId)
    // The outcome stands whatever happens here: the project may be going with its runs
    void this.publish(ctx).catch(error => console.error(`Publishing run ${ctx.run.id} failed`, error))
      .then(() => this.#c.scheduler.poke(handoff && ctx.task ? [ctx.task.id] : []))
  }

  // Slots in use on each runner, for the runner list (design/settings.md)
  async refreshLoad(): Promise<void> {
    const busy = await this.#c.d.db.select({ runnerId: runs.runnerId, n: count() }).from(runs)
      .where(and(inArray(runs.state, [...ACTIVE_RUN_STATES]), isNotNull(runs.runnerId)))
      .groupBy(runs.runnerId)
    this.#c.d.runner.setInUse(new Map(busy.map(b => [b.runnerId!, b.n])))
  }

  async publish(ctx: RunContext): Promise<void> {
    const { db, events } = this.#c.d
    events.publish({ type: 'run.updated', run: await getRun(db, ctx.run.id) })
    await this.refreshLoad()
    // A soft-deleted task has nothing left to show
    const task = ctx.task ? await loadTask(db, ctx.task.id).catch(() => null) : null
    if (task) events.publish({ type: 'task.updated', task })
    if (task?.status === 'merged') this.#c.scheduler.poke(await publishDependents(db, events, task.id))
  }
}
