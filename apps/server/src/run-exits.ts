import type { RunEvent, RunExit, RunnerMessage } from '@corral/contracts'
import { isActiveRun, isUuid } from '@corral/core'
import { schema, type Database, type RunRow } from '@corral/db'
import { and, eq, isNull, lt, or } from 'drizzle-orm'
import type { EventBus } from './events.ts'
import type { LeaseReconcile } from './lease-reconcile.ts'
import type { PlanService } from './plan.ts'
import type { RunContext, RunContexts } from './run-context.ts'
import { failAttempt, lastPmReply, type RunEnding } from './run-ending.ts'
import { runExitError } from './run-exit.ts'
import { restoreRunEnd } from './run-lifecycle.ts'
import { hasLastActivity, STOP, stoppedBy, withLastActivity } from './run-stops.ts'
import { listAgents } from './runs.ts'
import type { Transcripts } from './transcripts.ts'
import { lockLiveTask } from './task-rows.ts'

const { agents, runs } = schema

interface RunExitsDeps {
  db: Database
  events: EventBus
  transcripts: Pick<Transcripts, 'append' | 'read' | 'finish'>
  now(): Date
  runs: Pick<RunContexts, 'load' | 'fenced'>
  ending: Pick<RunEnding, 'endRun' | 'failRun' | 'publish'>
  leases: Pick<LeaseReconcile, 'confirmLease'>
  plans: Pick<PlanService, 'onRunStarted' | 'onRunEnded'>
  wake(): void
}

// How long to wait after a usage limit with no known reset time (D3)
const RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000

// Whether this run was ended as lost when its runner reconnected
function reconciled(run: RunRow, leaseEpoch: number): boolean {
  return run.state === 'interrupted' && run.leaseEpoch === leaseEpoch && stoppedBy(run.error, STOP.runnerRestarted)
}

export class RunExits {
  #d: RunExitsDeps

  constructor(deps: RunExitsDeps) {
    this.#d = deps
  }

  async onRunMessage(message: Extract<RunnerMessage, { type: 'run.started' | 'run.events' | 'run.ended' }>, runnerId: string): Promise<void> {
    const { db, events, transcripts } = this.#d
    // IDs come from the runner; a malformed one is simply unknown
    const owner = isUuid(message.runId) ? await this.#d.runs.load(message.runId) : null
    if (!owner || owner.run.runnerId !== runnerId) return
    if (message.type === 'run.events') {
      // A replay after the transcript was stored would only start a new spool
      if (owner.run.transcriptBlob) return
      // Transcript lines are kept even from a stale run: they're history, not writes
      const offset = await transcripts.append(message.runId, message.events)
      events.publish({ type: 'run.events', runId: message.runId, offset, events: message.events })
      const usage = message.events.filter((e): e is Extract<RunEvent, { type: 'usage' }> => e.type === 'usage').at(-1)
      if (usage) {
        await db.update(runs).set({ inputTokens: usage.inputTokens, cacheWriteTokens: usage.cacheWriteTokens ?? null, cacheReadTokens: usage.cacheReadTokens, outputTokens: usage.outputTokens }).where(eq(runs.id, message.runId))
      }
      return
    }

    if (message.type === 'run.started') {
      const ctx = await this.#d.runs.fenced(message.runId, message.leaseEpoch)
      if (!ctx) {
        // Sent while the socket was down: the run really did start, and a
        // retry resumes its session
        if (reconciled(owner.run, message.leaseEpoch)) {
          await db.update(runs).set({ startedAt: owner.run.startedAt ?? this.#d.now(), agentSessionId: message.agentSessionId, ...(message.resumeFailed && owner.run.sessionStart ? { sessionStart: 'fresh' as const } : {}) }).where(eq(runs.id, owner.run.id))
          if (owner.kind === 'pm' && owner.run.planSessionId) await this.#d.plans.onRunStarted(owner.run.planSessionId, message.agentSessionId)
        }
        return
      }
      // Only from before it started: a replay must not move a run back or
      // restart its clock. Still active: the server may have ended the run
      // since it was fenced.
      await db.update(runs).set({ state: 'running', startedAt: this.#d.now(), agentSessionId: message.agentSessionId,
        // Only runs that record how their session began
        ...(message.resumeFailed && ctx.run.sessionStart ? { sessionStart: 'fresh' as const } : {}),
        ...(message.initialHeadSha && ctx.run.retryContext ? { retryContext: { ...ctx.run.retryContext, head: message.initialHeadSha } } : {}) })
        .where(and(eq(runs.id, ctx.run.id), eq(runs.state, 'queued')))
      this.#d.leases.confirmLease(ctx, message.sentAt)
      if (ctx.kind === 'pm' && ctx.run.planSessionId) await this.#d.plans.onRunStarted(ctx.run.planSessionId, message.agentSessionId)
      await this.#d.ending.publish(ctx)
      return
    }

    // run.ended
    const ctx = await this.#d.runs.load(message.runId)
    if (!ctx) return
    const live = isActiveRun(ctx.run.state) && ctx.run.leaseEpoch === message.leaseEpoch
    if (live && ctx.kind === 'pm') await this.#pmExited(ctx, message.exit, message.lastActivityAt)
    else if (live) await this.#runExited(ctx, message.exit, message.lastActivityAt, message.wipSha ?? null, message.headSha ?? null)
    else if (reconciled(ctx.run, message.leaseEpoch)) await this.#restoreExit(ctx, message.exit, message.lastActivityAt)
    // The server already ended a run it stopped; only the runner knows the agent's last activity
    else if (ctx.run.state === 'interrupted' && ctx.run.error && ctx.run.leaseEpoch === message.leaseEpoch && !hasLastActivity(ctx.run.error)) {
      await db.update(runs).set({ error: withLastActivity(ctx.run.error, message.lastActivityAt) }).where(eq(runs.id, ctx.run.id))
    }
    // The commit that saved a stopped run's work, for the retry's prompt
    if (!live && message.wipSha && ctx.run.leaseEpoch === message.leaseEpoch) {
      await db.update(runs).set({ headSha: message.wipSha }).where(eq(runs.id, ctx.run.id))
    }
    const blob = await transcripts.finish(ctx.run.id)
    if (blob) await db.update(runs).set({ transcriptBlob: blob }).where(eq(runs.id, ctx.run.id))
    // Kept whether or not the run is live: an accepted outcome already ended it
    if (message.timings) await db.update(runs).set({ timings: message.timings }).where(eq(runs.id, ctx.run.id))
    await this.#d.ending.publish(ctx)
    this.#d.wake()
  }

  // A run.ended replayed after reconnecting (the runner's outbox), for a run
  // this server took as lost with the runner. What the agent really did stands
  // where it's safe: facts about the agent always are, but the task only
  // counts the failure if no newer run has claimed it since.
  async #restoreExit(ctx: RunContext, exit: RunExit, lastActivityAt: string | null | undefined): Promise<void> {
    const { db, transcripts } = this.#d
    const ended = ctx.run.endedAt ?? this.#d.now()
    if (exit.kind === 'rate_limited') {
      await this.#rateLimited(ctx, exit, end => restoreRunEnd(db, ctx.run.id, end, ended, { error: null }))
      return
    }
    if (ctx.kind === 'pm') {
      const reply = lastPmReply(await transcripts.read(ctx.run.id, null))
      if (reply) {
        await restoreRunEnd(db, ctx.run.id, { state: 'completed', summary: reply }, ended, { error: null })
        if (ctx.run.planSessionId) await this.#d.plans.onRunEnded(ctx.run.planSessionId, ctx.run.id, reply, null)
      }
      return
    }
    const error = runExitError(exit, lastActivityAt)
    if (exit.kind === 'stopped' || exit.kind === 'runner_shutdown') {
      await db.update(runs).set({ error }).where(and(eq(runs.id, ctx.run.id), eq(runs.state, 'interrupted')))
      return
    }
    // An epic fix spent its attempt when the reconnect interrupted it.
    // Restore the exit facts without charging the replay a second time.
    await db.transaction(async (tx) => {
      // A soft-deleted task has nothing to count against
      const locked = ctx.task ? await lockLiveTask(tx, ctx.task.id) : null
      if (locked && !locked.task.leaseRunId && locked.task.leaseEpoch === ctx.run.leaseEpoch) {
        await failAttempt(tx, locked, { ...ctx, run: { ...ctx.run, retryContext: null } }, error, null)
      }
      await restoreRunEnd(tx, ctx.run.id, { state: 'failed', outcome: 'failed', error }, ended, { retryContext: null })
    })
  }

  // D3: a usage limit is a pause, not a failure. The run completes and its
  // agent waits until the limit resets. `end` writes the run's end.
  async #rateLimited(ctx: RunContext, exit: Extract<RunExit, { kind: 'rate_limited' }>, end: (end: { state: 'completed', outcome: 'rate_limited', summary: string, rateLimitResetAt: Date }) => Promise<unknown>): Promise<Date> {
    const resetsAt = exit.resetsAt ? new Date(exit.resetsAt) : new Date(this.#d.now().getTime() + RATE_LIMIT_BACKOFF_MS)
    await end({ state: 'completed', outcome: 'rate_limited', rateLimitResetAt: resetsAt, summary: 'Hit a usage limit' })
    const { db, events } = this.#d
    await db.update(agents).set({ pausedUntil: resetsAt }).where(and(eq(agents.id, ctx.agent.id), or(isNull(agents.pausedUntil), lt(agents.pausedUntil, resetsAt))))
    const agent = (await listAgents(db)).find(a => a.id === ctx.agent.id)
    if (agent) events.publish({ type: 'agent.updated', agent })
    return resetsAt
  }

  // A PM turn has no outcome to report: its reply is the last thing it said
  async #pmExited(ctx: RunContext, exit: RunExit, lastActivityAt: string | null | undefined): Promise<void> {
    const events = await this.#d.transcripts.read(ctx.run.id, null)
    const reply = lastPmReply(events)
    let error: string | null = null
    switch (exit.kind) {
      case 'rate_limited': {
        const resetsAt = await this.#rateLimited(ctx, exit, end => this.#d.ending.endRun(ctx, end))
        error = `${ctx.agent.name} hit a usage limit; try again after ${resetsAt.toISOString()}`
        break
      }
      case 'exited':
      case 'signalled':
        if ((exit.kind === 'exited' && exit.code === 0) || reply) {
          await this.#d.ending.endRun(ctx, { state: 'completed', summary: reply })
        } else {
          error = exit.kind === 'exited' ? `The PM exited with code ${exit.code}` : runExitError(exit, lastActivityAt)
          await this.#d.ending.endRun(ctx, { state: 'failed', outcome: 'failed', error })
        }
        break
      case 'stopped':
      case 'runner_shutdown':
        await this.#d.ending.endRun(ctx, { state: 'interrupted', error: runExitError(exit, lastActivityAt) })
        error = 'The turn was stopped'
        break
      case 'timed_out':
        await this.#d.ending.endRun(ctx, { state: 'failed', outcome: 'failed', error: runExitError(exit, lastActivityAt) })
        error = 'The turn hit its time limit'
        break
      case 'error':
        await this.#d.ending.endRun(ctx, { state: 'failed', outcome: 'failed', error: exit.message })
        error = exit.message
        break
    }
    // A turn that ends without saying anything still answers the human, with
    // what the runner noted last (e.g. "The agent ended with an error: …")
    if (!reply && !error) {
      const note = events.filter((e): e is Extract<RunEvent, { type: 'system' }> => e.type === 'system').at(-1)?.text
      error = note ?? `${ctx.agent.name} finished without replying`
    }
    if (ctx.run.planSessionId) await this.#d.plans.onRunEnded(ctx.run.planSessionId, ctx.run.id, reply, error)
  }

  // The agent process ended without its outcome having been accepted
  async #runExited(ctx: RunContext, exit: RunExit, lastActivityAt: string | null | undefined, wipSha: string | null, head: string | null): Promise<void> {
    switch (exit.kind) {
      case 'rate_limited':
        await this.#rateLimited(ctx, exit, end => this.#d.ending.endRun(ctx, end))
        return
      case 'stopped':
      case 'runner_shutdown':
        await this.#d.ending.endRun(ctx, { state: 'interrupted', error: runExitError(exit, lastActivityAt), headSha: wipSha })
        return
      case 'error':
      case 'signalled':
      case 'timed_out':
        // A runtime or infrastructure cut still respects the failed-run cap,
        // but cannot establish a completed no-progress attempt.
        ctx.run.retryContext = null
        await this.#d.db.update(runs).set({ retryContext: null }).where(eq(runs.id, ctx.run.id))
        await this.#d.ending.failRun(ctx, runExitError(exit, lastActivityAt), { headSha: wipSha ?? ctx.run.headSha })
        return
      default:
        // An ordinary exit without an outcome is still a failed attempt, and
        // its local head is what repetition compares.
        // Epic review caps continue to count against their claimed head.
        await this.#d.ending.failRun(ctx, runExitError(exit, lastActivityAt), { headSha: wipSha ?? head ?? ctx.run.headSha })
    }
  }
}
