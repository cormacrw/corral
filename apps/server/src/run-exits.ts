import type { RunEvent, RunExit, RunnerMessage } from '@corral/contracts'
import { isActiveRun } from '@corral/core'
import { schema } from '@corral/db'
import { and, eq, inArray, isNull, lt, or } from 'drizzle-orm'
import { LAST_ACTIVITY, runExitError, withLastActivity } from './run-exit.ts'
import { runEndValues } from './run-lifecycle.ts'
import { listAgents } from './runs.ts'
import { applyTransition, lockTask } from './tasks.ts'
import { RUNNER_RESTARTED, UUID, server, type RunContext, type RunCore, type RunRow } from './run-context.ts'
import { lastPmReply } from './run-ending.ts'

const { agents, runs } = schema

// How long to wait after a usage limit with no known reset time (D3)
const RATE_LIMIT_BACKOFF_MS = 30 * 60 * 1000

// Whether this run was ended as lost when its runner reconnected
function reconciled(run: RunRow, leaseEpoch: number): boolean {
  return run.state === 'interrupted' && run.leaseEpoch === leaseEpoch && (run.error ?? '').startsWith(RUNNER_RESTARTED)
}

export class RunExits {
  #c: RunCore

  constructor(core: RunCore) {
    this.#c = core
  }

  async onRunMessage(message: Extract<RunnerMessage, { type: 'run.started' | 'run.events' | 'run.ended' }>, runnerId: string): Promise<void> {
    const { db, events, transcripts } = this.#c.d
    // IDs come from the runner; a malformed one is simply unknown
    const owner = UUID.test(message.runId) ? await this.#c.runs.load(message.runId) : null
    if (!owner || owner.run.runnerId !== runnerId) return
    if (message.type === 'run.events') {
      // A replay after the transcript was stored would only start a new spool
      if (owner.run.transcriptBlob) return
      // Transcript lines are kept even from a stale run: they're history, not writes
      const offset = await transcripts.append(message.runId, message.events)
      events.publish({ type: 'run.events', runId: message.runId, offset, events: message.events })
      const usage = message.events.filter((e): e is Extract<RunEvent, { type: 'usage' }> => e.type === 'usage').at(-1)
      if (usage) {
        await db.update(runs).set({ inputTokens: usage.inputTokens, cacheReadTokens: usage.cacheReadTokens, outputTokens: usage.outputTokens }).where(eq(runs.id, message.runId))
      }
      return
    }

    if (message.type === 'run.started') {
      const ctx = await this.#c.runs.fenced(message.runId, message.leaseEpoch)
      if (!ctx) {
        // Sent while the socket was down: the run really did start, and a
        // retry resumes its session
        if (reconciled(owner.run, message.leaseEpoch)) {
          await db.update(runs).set({ startedAt: owner.run.startedAt ?? this.#c.now(), agentSessionId: message.agentSessionId }).where(eq(runs.id, owner.run.id))
          if (owner.run.role === 'pm' && owner.run.planSessionId) await this.#c.plans?.onRunStarted(owner.run.planSessionId, message.agentSessionId)
        }
        return
      }
      // Only from before it started: a replay must not move a run back or
      // restart its clock. Still active: the server may have ended the run
      // since it was fenced.
      await db.update(runs).set({ state: 'running', startedAt: this.#c.now(), agentSessionId: message.agentSessionId })
        .where(and(eq(runs.id, ctx.run.id), inArray(runs.state, ['queued', 'starting'])))
      this.#c.leases.confirmLease(ctx, message.sentAt)
      if (ctx.run.role === 'pm' && ctx.run.planSessionId) await this.#c.plans?.onRunStarted(ctx.run.planSessionId, message.agentSessionId)
      await this.#c.ending.publish(ctx)
      return
    }

    // run.ended
    const ctx = await this.#c.runs.load(message.runId)
    if (!ctx) return
    const live = isActiveRun(ctx.run.state) && ctx.run.leaseEpoch === message.leaseEpoch
    if (live && ctx.run.role === 'pm') await this.#pmExited(ctx, message.exit, message.lastActivityAt)
    else if (live) await this.#runExited(ctx, message.exit, message.lastActivityAt, message.wipSha ?? null)
    else if (reconciled(ctx.run, message.leaseEpoch)) await this.#restoreExit(ctx, message.exit, message.lastActivityAt)
    // The server already ended a run it stopped; only the runner knows the agent's last activity
    else if (ctx.run.state === 'interrupted' && ctx.run.error && ctx.run.leaseEpoch === message.leaseEpoch && !ctx.run.error.includes(LAST_ACTIVITY)) {
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
    await this.#c.ending.publish(ctx)
    this.#c.scheduler.poke()
  }

  // A run.ended replayed after reconnecting (the runner's outbox), for a run
  // this server took as lost with the runner. What the agent really did stands
  // where it's safe: facts about the agent always are, but the task only
  // counts the failure if no newer run has claimed it since.
  async #restoreExit(ctx: RunContext, exit: RunExit, lastActivityAt: string | null | undefined): Promise<void> {
    const { db, transcripts } = this.#c.d
    const ended = ctx.run.endedAt ?? this.#c.now()
    const reconciledRun = and(eq(runs.id, ctx.run.id), eq(runs.state, 'interrupted'))
    if (ctx.run.role === 'pm' && exit.kind !== 'rate_limited') {
      const reply = lastPmReply(await transcripts.read(ctx.run.id, null))
      if (reply) {
        await db.update(runs).set({ ...runEndValues({ state: 'completed', summary: reply }, ended), error: null }).where(reconciledRun)
        if (ctx.run.planSessionId) await this.#c.plans?.onRunEnded(ctx.run.planSessionId, ctx.run.id, reply, null)
      }
      return
    }
    switch (exit.kind) {
      case 'rate_limited': {
        const resetsAt = this.#limitResetsAt(exit)
        await db.update(runs).set({ ...runEndValues({ state: 'completed', outcome: 'rate_limited', rateLimitResetAt: resetsAt, summary: 'Hit a usage limit' }, ended), error: null }).where(reconciledRun)
        await this.#pauseAgent(ctx, resetsAt)
        return
      }
      case 'stopped':
      case 'runner_shutdown':
        await db.update(runs).set({ error: runExitError(exit, lastActivityAt) }).where(reconciledRun)
        return
      default: {
        const error = runExitError(exit, lastActivityAt)
        await db.transaction(async (tx) => {
          const locked = ctx.task ? await lockTask(tx, ctx.task.id).catch(() => null) : null
          if (locked && !locked.task.leaseRunId && locked.task.leaseEpoch === ctx.run.leaseEpoch && ['in_progress', 'agent_review'].includes(locked.task.status)) {
            await applyTransition(tx, locked.task, locked.project, { type: 'run_failed' }, server, { event: 'run_failed', runId: ctx.run.id, error })
          }
          await tx.update(runs).set(runEndValues({ state: 'failed', outcome: 'failed', error }, ended)).where(reconciledRun)
        })
      }
    }
  }

  #limitResetsAt(exit: Extract<RunExit, { kind: 'rate_limited' }>): Date {
    return exit.resetsAt ? new Date(exit.resetsAt) : new Date(this.#c.now().getTime() + RATE_LIMIT_BACKOFF_MS)
  }

  // D3: a pause, not a failure. The agent waits until the limit resets.
  async #pauseAgent(ctx: RunContext, resetsAt: Date): Promise<void> {
    const { db, events } = this.#c.d
    await db.update(agents).set({ pausedUntil: resetsAt }).where(and(eq(agents.id, ctx.agent.id), or(isNull(agents.pausedUntil), lt(agents.pausedUntil, resetsAt))))
    const agent = (await listAgents(db)).find(a => a.id === ctx.agent.id)
    if (agent) events.publish({ type: 'agent.updated', agent })
  }

  // A PM turn has no outcome to report: its reply is the last thing it said
  async #pmExited(ctx: RunContext, exit: RunExit, lastActivityAt: string | null | undefined): Promise<void> {
    const events = await this.#c.d.transcripts.read(ctx.run.id, null)
    const reply = lastPmReply(events)
    let error: string | null = null
    switch (exit.kind) {
      case 'rate_limited': {
        const resetsAt = this.#limitResetsAt(exit)
        await this.#c.ending.endRun(ctx, { state: 'completed', outcome: 'rate_limited', rateLimitResetAt: resetsAt, summary: 'Hit a usage limit' })
        await this.#pauseAgent(ctx, resetsAt)
        error = `${ctx.agent.name} hit a usage limit; try again after ${resetsAt.toISOString()}`
        break
      }
      case 'exited':
      case 'signalled':
        if ((exit.kind === 'exited' && exit.code === 0) || reply) {
          await this.#c.ending.endRun(ctx, { state: 'completed', summary: reply })
        } else {
          error = exit.kind === 'exited' ? `The PM exited with code ${exit.code}` : runExitError(exit, lastActivityAt)
          await this.#c.ending.endRun(ctx, { state: 'failed', outcome: 'failed', error })
        }
        break
      case 'stopped':
      case 'runner_shutdown':
        await this.#c.ending.endRun(ctx, { state: 'interrupted', error: runExitError(exit, lastActivityAt) })
        error = 'The turn was stopped'
        break
      case 'timed_out':
        await this.#c.ending.endRun(ctx, { state: 'failed', outcome: 'failed', error: runExitError(exit, lastActivityAt) })
        error = 'The turn hit its time limit'
        break
      case 'error':
        await this.#c.ending.endRun(ctx, { state: 'failed', outcome: 'failed', error: exit.message })
        error = exit.message
        break
    }
    // A turn that ends without saying anything still answers the human, with
    // what the runner noted last (e.g. "The agent ended with an error: …")
    if (!reply && !error) {
      const note = events.filter((e): e is Extract<RunEvent, { type: 'system' }> => e.type === 'system').at(-1)?.text
      error = note ?? `${ctx.agent.name} finished without replying`
    }
    if (ctx.run.planSessionId) await this.#c.plans?.onRunEnded(ctx.run.planSessionId, ctx.run.id, reply, error)
  }

  // The agent process ended without its outcome having been accepted
  async #runExited(ctx: RunContext, exit: RunExit, lastActivityAt: string | null | undefined, headSha: string | null): Promise<void> {
    switch (exit.kind) {
      case 'rate_limited': {
        const resetsAt = this.#limitResetsAt(exit)
        await this.#c.ending.endRun(ctx, { state: 'completed', outcome: 'rate_limited', rateLimitResetAt: resetsAt, summary: 'Hit a usage limit' })
        await this.#pauseAgent(ctx, resetsAt)
        return
      }
      case 'stopped':
      case 'runner_shutdown':
        await this.#c.ending.endRun(ctx, { state: 'interrupted', error: runExitError(exit, lastActivityAt), headSha })
        return
      default:
        // An epic review keeps the head it was claimed for: failures count per head
        await this.#c.ending.failRun(ctx, runExitError(exit, lastActivityAt), { headSha: headSha ?? ctx.run.headSha })
    }
  }
}
