import type { Comment, RunEvent } from '@corral/contracts'
import { ACTIVE_RUN_STATES, SERVER_ACTOR, TRANSITION_RULES } from '@corral/core'
import { schema, type Database, type Executor, type ProjectRow, type TaskRow } from '@corral/db'
import { and, count, eq, inArray, isNotNull } from 'drizzle-orm'
import { publishDependents } from './dependent-tasks.ts'
import { countFixFailure, lockFixOperation } from './epic-fixes.ts'
import type { EpicPullRequests } from './epic-prs.ts'
import type { EpicReviewRuns } from './epic-review-runs.ts'
import type { EventBus } from './events.ts'
import type { GitHubClient } from './github.ts'
import type { PlanService } from './plan.ts'
import { retryContext, stopRepeated } from './retry-recovery.ts'
import { runActor, type RunContext, type RunContexts } from './run-context.ts'
import { endRunIn, type RunEnd } from './run-lifecycle.ts'
import { keepsWork, neverStarted } from './run-stops.ts'
import type { RunnerHub } from './runner-hub.ts'
import { getRun } from './runs.ts'
import { applyTransition } from './tasks.ts'
import type { Transcripts } from './transcripts.ts'
import { addComment } from './comments.ts'
import { loadTasks } from './task-views.ts'
import { lockTask } from './task-rows.ts'

const { runs, tasks } = schema

// A PM turn's reply is the last thing it said (D9)
export function lastPmReply(events: RunEvent[]): string | null {
  return events.filter((e): e is Extract<RunEvent, { type: 'message' }> => e.type === 'message').at(-1)?.text ?? null
}

// D10: a failed run counts towards its task's failed-run cap; at the cap the
// task fails. A failure that repeats the last one without progress stops the
// retries. Under the task's lock, which the caller checked the run may count on.
export async function failAttempt(tx: Executor, locked: { task: TaskRow, project: ProjectRow }, ctx: RunContext, error: string, head: string | null): Promise<void> {
  if (!TRANSITION_RULES.run_failed.from.includes(locked.task.status)) return
  await applyTransition(tx, locked.task, locked.project, { type: 'run_failed' }, SERVER_ACTOR, { event: 'run_failed', runId: ctx.run.id, error })
  const [failed] = await tx.select().from(tasks).where(eq(tasks.id, locked.task.id))
  await stopRepeated(tx, ctx.run, ctx.task!.status, failed!, head)
}

export interface RunEndingDeps {
  db: Database
  events: EventBus
  runner: Pick<RunnerHub, 'send' | 'setInUse'>
  transcripts: Pick<Transcripts, 'append' | 'read'>
  github: GitHubClient
  now(): Date
  runs: RunContexts
  plans: Pick<PlanService, 'notifyParent' | 'onRunEnded'>
  epicPrs: Pick<EpicPullRequests, 'publish'>
  epicReviews: Pick<EpicReviewRuns, 'reviewFailed'>
  // Asks for a scheduling pass, for these tasks first
  wake(taskIds?: readonly string[]): void
}

// The one owner of how a run ends: every end goes through endRunIn, and every
// stop ends the run before it tells the runner (see Placement.dispatch).
export class RunEnding {
  #d: RunEndingDeps

  constructor(deps: RunEndingDeps) {
    this.#d = deps
  }

  // A line in the run's transcript from Corral itself
  async note(runId: string, text: string): Promise<void> {
    const events: RunEvent[] = [{ type: 'system', text }]
    const offset = await this.#d.transcripts.append(runId, events)
    this.#d.events.publish({ type: 'run.events', runId, offset, events })
  }

  // A failed run counts towards the failed-run cap (D10); at the cap the task fails
  async failRun(ctx: RunContext, error: string, fields: Partial<typeof runs.$inferInsert> = {}, note?: string): Promise<void> {
    // New input while the agent was running breaks the repetition streak.
    if (ctx.task && ctx.run.retryContext) {
      const current = await retryContext(this.#d, ctx)
      if (!current || current.target !== ctx.run.retryContext.target || current.human !== ctx.run.retryContext.human) {
        ctx.run.retryContext = null
        fields.retryContext = null
      }
    }
    let reviewHandedOver = false
    const comment = await this.#d.db.transaction(async (tx) => {
      const comment = note && ctx.task ? await this.postNote(tx, ctx, note) : null
      if (ctx.task) {
        const locked = await lockTask(tx, ctx.task.id)
        if (locked.task.leaseRunId === ctx.run.id) await failAttempt(tx, locked, ctx, error, fields.headSha ?? null)
      }
      if (ctx.kind === 'epic_review') reviewHandedOver = await this.#d.epicReviews.reviewFailed(tx, ctx.run, error)
      await this.endRunIn(tx, ctx, { ...fields, state: 'failed', outcome: 'failed', error })
      return comment
    })
    if (comment) this.#d.events.publish({ type: 'comment.created', comment })
    if (reviewHandedOver) await this.#d.epicPrs.publish(ctx.run.epicId!)
  }

  // The developer's work note: what this run did, as a comment by its agent,
  // so the task's history shows the developer's turns between reviews
  async postNote(tx: Executor, ctx: RunContext, note: string): Promise<Comment> {
    return addComment(tx, ctx.task!.id, { body: note, pinned: false }, runActor(ctx))
  }

  async endRun(ctx: RunContext, end: RunEnd): Promise<boolean> {
    const ended = await this.#d.db.transaction(tx => this.endRunIn(tx, ctx, end))
    if (ended && ctx.kind === 'pm' && ctx.run.planSessionId && end.state === 'interrupted') {
      await this.#d.plans.notifyParent(ctx.run.planSessionId, ctx.run.id, true)
    }
    return ended
  }

  // Ends the run and releases its lease, if it still holds one. Whether this
  // ended it: an outcome accepted since `ctx` was read stands, and isn't
  // overwritten or audited twice.
  async endRunIn(tx: Executor, ctx: RunContext, end: RunEnd): Promise<boolean> {
    if (ctx.kind === 'epic_fix') await lockFixOperation(tx, ctx.run)
    const ended = await endRunIn(tx, ctx.run, end, this.#d.now())
    if (ended && ctx.kind === 'epic_fix' && (end.state === 'failed' || (end.state === 'interrupted' && !keepsWork(end.error) && !neverStarted(end.error)))) {
      await countFixFailure(tx, ctx.run, end.error, this.#d.now())
    }
    return ended
  }

  // The server ends a run the agent didn't finish. Its run.ended won't count
  // any more, so a PM turn's session hears now: whatever it said, or why not.
  async interrupted(ctx: RunContext, error: string): Promise<void> {
    if (!await this.endRun(ctx, { state: 'interrupted', error })) return
    if (ctx.kind !== 'pm' || !ctx.run.planSessionId) return
    await this.#d.plans.onRunEnded(ctx.run.planSessionId, ctx.run.id, lastPmReply(await this.#d.transcripts.read(ctx.run.id, null)), error)
  }

  // The outcome is recorded; the runner stops the agent's process tree. A
  // handoff (a pushed PR, a verdict) lets the next agent start the task now.
  finished(ctx: RunContext, reason: string, { handoff = false } = {}): void {
    this.#d.runner.send({ type: 'run.stop', runId: ctx.run.id, reason }, ctx.run.runnerId)
    // The outcome stands whatever happens here: the project may be going with its runs
    void this.publish(ctx).catch(error => console.error(`Publishing run ${ctx.run.id} failed`, error))
      .then(() => this.#d.wake(handoff && ctx.task ? [ctx.task.id] : []))
  }

  // The only way a live run is stopped: it ends the run, then tells the
  // runner, in that order (see Placement.dispatch). A human's stop does its
  // own writes in the ending's transaction, goes no further if the run had
  // already ended, and leaves a PM turn's reply to the Plan thread's close.
  async stop(ctx: RunContext, error: string, message: { reason: string, keepWork?: true }, human?: { alsoIn(tx: Executor): Promise<void> }): Promise<boolean> {
    const ended = await this.#d.db.transaction(async (tx) => {
      if (!await this.endRunIn(tx, ctx, { state: 'interrupted', error })) return false
      await human?.alsoIn(tx)
      return true
    })
    if (!ended && human) return false
    if (ended && ctx.kind === 'pm' && ctx.run.planSessionId) {
      await this.#d.plans.notifyParent(ctx.run.planSessionId, ctx.run.id, true)
      if (!human) await this.#d.plans.onRunEnded(ctx.run.planSessionId, ctx.run.id, lastPmReply(await this.#d.transcripts.read(ctx.run.id, null)), error)
    }
    this.#d.runner.send({ type: 'run.stop', runId: ctx.run.id, ...message }, ctx.run.runnerId)
    await this.publish(ctx)
    return ended
  }

  // Slots in use on each runner, for the runner list (design/settings.md)
  async refreshLoad(): Promise<void> {
    const busy = await this.#d.db.select({ runnerId: runs.runnerId, n: count() }).from(runs)
      .where(and(inArray(runs.state, [...ACTIVE_RUN_STATES]), isNotNull(runs.runnerId)))
      .groupBy(runs.runnerId)
    this.#d.runner.setInUse(new Map(busy.map(b => [b.runnerId!, b.n])))
  }

  async publish(ctx: RunContext): Promise<void> {
    const { db, events } = this.#d
    events.publish({ type: 'run.updated', run: await getRun(db, ctx.run.id) })
    await this.refreshLoad()
    if (ctx.kind === 'epic_fix') await this.#d.epicPrs.publish(ctx.run.epicId!)
    // A soft-deleted task has nothing left to show
    const [task] = ctx.task ? await loadTasks(db, [ctx.task.id]) : []
    if (task) events.publish({ type: 'task.updated', task })
    if (task?.status === 'merged') this.#d.wake(await publishDependents(db, events, task.id))
  }
}
