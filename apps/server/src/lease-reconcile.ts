import { RUNNER_HEARTBEAT_MS } from '@corral/contracts'
import { ACTIVE_RUN_STATES, LEASE_DURATION_MS } from '@corral/core'
import { schema } from '@corral/db'
import { and, eq, inArray, isNotNull, isNull, lt, or } from 'drizzle-orm'
import { KEEP_WORK_STOPS, RUNNER_RESTARTED, UUID, type RunContext, type RunCore } from './run-context.ts'

const { runs, tasks } = schema

// How often orphaned transcript spools are looked for, and how long after its
// run ended one may still get a replayed run.ended
const SPOOL_GRACE_MS = 60 * 60 * 1000

export class LeaseReconcile {
  #c: RunCore
  // After a restart, leases that ran out while the server was down are left
  // for the runners to renew as they reconnect
  sweepFrom = 0
  spoolsSweptAt = Date.now()

  constructor(core: RunCore) {
    this.#c = core
  }

  // Expired leases: the runner stopped heartbeating (e.g. the laptop slept).
  // The run is Interrupted, not Failed, and the task waits for a retry (D10).
  async sweepLeases(): Promise<void> {
    const now = this.#c.now()
    if (now.getTime() < this.sweepFrom) return
    // Epic reviews and PM turns hold their lease on the run. A turn still
    // holding its job was never sent, and a turn sent before PM leases
    // existed has none, so it's timed from when it was queued.
    const expiredRuns = await this.#c.d.db.select({ id: runs.id }).from(runs).where(and(
      inArray(runs.state, [...ACTIVE_RUN_STATES]),
      isNull(runs.pmJob),
      or(lt(runs.leaseExpiresAt, now), and(eq(runs.role, 'pm'), isNull(runs.leaseExpiresAt), lt(runs.queuedAt, new Date(now.getTime() - LEASE_DURATION_MS))))
    ))
    const expired = await this.#c.d.db.select({ runId: tasks.leaseRunId }).from(tasks)
      .where(and(isNotNull(tasks.leaseRunId), lt(tasks.leaseExpiresAt, now)))
    for (const id of [...expiredRuns.map(r => r.id), ...expired.map(r => r.runId!)]) {
      const ctx = await this.#c.runs.load(id)
      if (!ctx) continue
      await this.#c.ending.stop(ctx, ctx.run.epicId ? 'Epic review lease expired' : ctx.run.role === 'pm' ? 'PM turn lease expired: no heartbeat from the runner' : 'Lease expired: no heartbeat from the runner', { reason: 'Lease expired' })
    }
  }

  // Transcripts of runs that never got a run.ended: the runner was lost or the
  // lease ran out. A replayed run.ended may still come, so they wait a while.
  async sweepSpools(): Promise<void> {
    const { db, transcripts } = this.#c.d
    this.spoolsSweptAt = Date.now()
    const spooled = (await transcripts.spooled()).filter(id => UUID.test(id))
    if (!spooled.length) return
    const rows = await db.select({ id: runs.id, state: runs.state, endedAt: runs.endedAt }).from(runs).where(inArray(runs.id, spooled))
    for (const id of spooled) {
      const run = rows.find(r => r.id === id)
      // Gone with its project
      if (!run) await transcripts.discard(id)
      else if (run.endedAt && this.#c.now().getTime() - run.endedAt.getTime() >= SPOOL_GRACE_MS) {
        const blob = await transcripts.finish(id)
        if (blob) await db.update(runs).set({ transcriptBlob: blob }).where(eq(runs.id, id))
      }
    }
  }

  async onConnected(activeRuns: { runId: string, leaseEpoch: number }[], runnerId: string): Promise<void> {
    const { db, runner } = this.#c.d
    // Runners keep agents alive through a server outage, and their leases run
    // out meanwhile. Fencing holds: a run that still has its lease at its
    // epoch was never given up, because only ending a run frees a lease, so
    // nothing else can have the task. A lost run is ended by then, and this
    // renews nothing for it.
    const now = this.#c.now()
    for (const active of activeRuns) {
      const ctx = await this.#c.runs.fenced(active.runId, active.leaseEpoch)
      if (ctx?.run.runnerId === runnerId) await this.#renewLease(ctx, now)
    }
    // Runs the server thinks are live but the runner doesn't have were lost
    // when the runner restarted
    const live = await db.select().from(runs).where(and(eq(runs.runnerId, runnerId), inArray(runs.state, [...ACTIVE_RUN_STATES])))
    for (const run of live) {
      // A PM turn waiting for a slot was never sent
      if (run.pmJob !== null) continue
      if (activeRuns.some(a => a.runId === run.id && a.leaseEpoch === run.leaseEpoch)) continue
      const ctx = await this.#c.runs.load(run.id)
      if (!ctx) continue
      await this.#c.ending.interrupted(ctx, RUNNER_RESTARTED)
      await this.#c.ending.publish(ctx)
    }
    await this.#c.ending.refreshLoad()
    // Runs the runner has but the server no longer recognises must stop
    for (const active of activeRuns) {
      const ctx = await this.#c.runs.fenced(active.runId, active.leaseEpoch)
      if (!ctx || ctx.run.runnerId !== runnerId) {
        if (await this.#savingWork(active.runId, active.leaseEpoch, runnerId)) continue
        runner.send({ type: 'run.stop', runId: active.runId, reason: 'The server no longer recognises this run' }, runnerId)
      }
    }
  }

  async onHeartbeat(activeRuns: { runId: string, leaseEpoch: number }[], runnerId: string, sentAt?: number): Promise<void> {
    const now = this.#c.now()
    for (const active of activeRuns) {
      const ctx = await this.#c.runs.fenced(active.runId, active.leaseEpoch)
      if (!ctx || ctx.run.runnerId !== runnerId || (ctx.task?.leaseExpiresAt && ctx.task.leaseExpiresAt <= now)) {
        if (await this.#savingWork(active.runId, active.leaseEpoch, runnerId)) continue
        this.#c.d.runner.send({ type: 'run.stop', runId: active.runId, reason: 'This run no longer holds its lease' }, runnerId)
        continue
      }
      await this.#renewLease(ctx, now)
      this.confirmLease(ctx, sentAt)
    }
  }

  async #renewLease(ctx: RunContext, now: Date): Promise<void> {
    const leaseExpiresAt = new Date(now.getTime() + LEASE_DURATION_MS)
    if (ctx.run.epicId || ctx.run.role === 'pm') await this.#c.d.db.update(runs).set({ leaseExpiresAt }).where(eq(runs.id, ctx.run.id))
    if (ctx.task) {
      await this.#c.d.db.update(tasks).set({ leaseHeartbeatAt: now, leaseExpiresAt })
        .where(and(eq(tasks.id, ctx.task.id), eq(tasks.leaseRunId, ctx.run.id), eq(tasks.leaseEpoch, ctx.run.leaseEpoch!)))
    }
  }

  // A human stop or the kill switch ends the run here at once, but the runner
  // lists it until the agent has exited. It was told to keep its work, so a
  // keepWork-less stop would wrongly revoke the push, unless the task moved on.
  // A lost lease also leaves a run interrupted: only these two stops count.
  // A run that never started has no work to save, and its stop may have
  // reached the runner before the assignment did, so it's stopped again.
  async #savingWork(runId: string, leaseEpoch: number, runnerId: string): Promise<boolean> {
    const ctx = await this.#c.runs.load(runId)
    if (!ctx?.task || ctx.task.deletedAt || ctx.task.leaseRunId !== null) return false
    const { run } = ctx
    return (run.role === 'developer' || run.role === 'designer') && run.state === 'interrupted' && run.startedAt !== null && run.leaseEpoch === leaseEpoch && run.runnerId === runnerId && KEEP_WORK_STOPS.has(run.error ?? '')
  }

  confirmLease(ctx: RunContext, sentAt: number | undefined): void {
    // Echo the runner's clock: delayed replies after sleep must already be expired,
    // and runner/server wall clocks need not agree. Older runners need no ack.
    if ((ctx.run.role !== 'developer' && ctx.run.role !== 'designer') || sentAt === undefined || !Number.isFinite(sentAt)) return
    this.#c.d.runner.send({ type: 'run.lease', runId: ctx.run.id, leaseEpoch: ctx.run.leaseEpoch!, validUntil: new Date(sentAt + 2 * RUNNER_HEARTBEAT_MS).toISOString() }, ctx.run.runnerId)
  }
}
