import { RUNNER_HEARTBEAT_MS } from '@corral/contracts'
import { ACTIVE_RUN_STATES, isAuthoringRole, isUuid } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, eq, gt, inArray } from 'drizzle-orm'
import type { RunContext, RunContexts } from './run-context.ts'
import type { RunEnding } from './run-ending.ts'
import { Lease } from './run-lease.ts'
import { keepsWork, STOP } from './run-stops.ts'
import type { RunnerHub } from './runner-hub.ts'
import type { Transcripts } from './transcripts.ts'
import { fixOperationState } from './epic-fixes.ts'

const { runs } = schema

export interface LeaseReconcileDeps {
  db: Database
  runner: Pick<RunnerHub, 'send'>
  transcripts: Pick<Transcripts, 'spooled' | 'discard' | 'finish'>
  now(): Date
  runs: Pick<RunContexts, 'load' | 'fenced'>
  ending: Pick<RunEnding, 'stop' | 'interrupted' | 'publish' | 'refreshLoad'>
}

// How often orphaned transcript spools are looked for, and how long after its
// run ended one may still get a replayed run.ended
const SPOOL_GRACE_MS = 60 * 60 * 1000

export class LeaseReconcile {
  #d: LeaseReconcileDeps
  // After a restart, leases that ran out while the server was down are left
  // for the runners to renew as they reconnect
  sweepFrom = 0
  #spoolsSweptAt: number

  constructor(deps: LeaseReconcileDeps) {
    this.#d = deps
    this.#spoolsSweptAt = deps.now().getTime()
  }

  spoolSweepDue(): boolean {
    return this.#d.now().getTime() - this.#spoolsSweptAt >= SPOOL_GRACE_MS
  }

  // Expired leases: the runner stopped heartbeating (e.g. the laptop slept).
  // The run is Interrupted, not Failed, and the task waits for a retry (D10).
  async sweepLeases(): Promise<void> {
    const now = this.#d.now()
    if (now.getTime() < this.sweepFrom) return
    for (const id of await Lease.expired(this.#d.db, now)) {
      const ctx = await this.#d.runs.load(id)
      if (!ctx) continue
      await this.#d.ending.stop(ctx, Lease.expiredStop(ctx.kind), { reason: 'Lease expired' })
    }
  }

  // Transcripts of runs that never got a run.ended: the runner was lost or the
  // lease ran out. A replayed run.ended may still come, so they wait a while.
  async sweepSpools(): Promise<void> {
    const { db, transcripts } = this.#d
    this.#spoolsSweptAt = this.#d.now().getTime()
    const spooled = (await transcripts.spooled()).filter(id => isUuid(id))
    if (!spooled.length) return
    const rows = await db.select({ id: runs.id, state: runs.state, endedAt: runs.endedAt }).from(runs).where(inArray(runs.id, spooled))
    for (const id of spooled) {
      const run = rows.find(r => r.id === id)
      // Gone with its project
      if (!run) await transcripts.discard(id)
      else if (run.endedAt && this.#d.now().getTime() - run.endedAt.getTime() >= SPOOL_GRACE_MS) {
        const blob = await transcripts.finish(id)
        if (blob) await db.update(runs).set({ transcriptBlob: blob }).where(eq(runs.id, id))
      }
    }
  }

  async onConnected(activeRuns: { runId: string, leaseEpoch: number }[], runnerId: string): Promise<void> {
    const { db, runner } = this.#d
    // Runners keep agents alive through a server outage, and their leases run
    // out meanwhile. Fencing holds: a run that still has its lease at its
    // epoch was never given up, because only ending a run frees a lease, so
    // nothing else can have the task. A lost run is ended by then, and this
    // renews nothing for it.
    const now = this.#d.now()
    for (const active of activeRuns) {
      const ctx = await this.#d.runs.fenced(active.runId, active.leaseEpoch)
      if (ctx?.run.runnerId === runnerId) await Lease.renew(this.#d.db, ctx, now)
    }
    // Runs the server thinks are live but the runner doesn't have were lost
    // when the runner restarted
    const live = await db.select().from(runs).where(and(eq(runs.runnerId, runnerId), inArray(runs.state, [...ACTIVE_RUN_STATES])))
    for (const run of live) {
      // A PM turn waiting for a slot was never sent
      if (run.pmJob !== null) continue
      if (activeRuns.some(a => a.runId === run.id && a.leaseEpoch === run.leaseEpoch)) continue
      const ctx = await this.#d.runs.load(run.id)
      if (!ctx) continue
      await this.#d.ending.interrupted(ctx, STOP.runnerRestarted)
      await this.#d.ending.publish(ctx)
    }
    await this.#d.ending.refreshLoad()
    // Runs the runner has but the server no longer recognises must stop
    for (const active of activeRuns) {
      const ctx = await this.#d.runs.fenced(active.runId, active.leaseEpoch)
      if (!ctx || ctx.run.runnerId !== runnerId) {
        if (await this.#savingWork(active.runId, active.leaseEpoch, runnerId)) continue
        runner.send({ type: 'run.stop', runId: active.runId, reason: 'The server no longer recognises this run' }, runnerId)
      }
    }
  }

  async onHeartbeat(activeRuns: { runId: string, leaseEpoch: number }[], runnerId: string, sentAt?: number): Promise<void> {
    const now = this.#d.now()
    for (const active of activeRuns) {
      const ctx = await this.#d.runs.fenced(active.runId, active.leaseEpoch)
      if (!ctx || ctx.run.runnerId !== runnerId || Lease.lapsed(ctx, now)) {
        if (await this.#savingWork(active.runId, active.leaseEpoch, runnerId)) continue
        this.#d.runner.send({ type: 'run.stop', runId: active.runId, reason: 'This run no longer holds its lease' }, runnerId)
        continue
      }
      await Lease.renew(this.#d.db, ctx, now)
      this.confirmLease(ctx, sentAt)
    }
  }

  // A human stop or the kill switch ends the run here at once, but the runner
  // lists it until the agent has exited. It was told to keep its work, so a
  // keepWork-less stop would wrongly revoke the push, unless the task moved on.
  // A lost lease also leaves a run interrupted: only these two stops count.
  // A run that never started has no work to save, and its stop may have
  // reached the runner before the assignment did, so it's stopped again.
  async #savingWork(runId: string, leaseEpoch: number, runnerId: string): Promise<boolean> {
    const ctx = await this.#d.runs.load(runId)
    if (!ctx) return false
    if (ctx.task) {
      if (ctx.task.deletedAt || ctx.task.leaseRunId !== null) return false
    } else if (ctx.kind === 'epic_fix' && ctx.run.operationId) {
      const state = await fixOperationState(this.#d.db, ctx.run)
      const [newer] = await this.#d.db.select({ id: runs.id }).from(runs).where(and(eq(runs.operationId, ctx.run.operationId), gt(runs.number, ctx.run.number))).limit(1)
      if (state !== 'running' || newer) return false
    } else return false
    const { run } = ctx
    return isAuthoringRole(run.role) && run.state === 'interrupted' && run.startedAt !== null && run.leaseEpoch === leaseEpoch && run.runnerId === runnerId && keepsWork(run.error)
  }

  confirmLease(ctx: RunContext, sentAt: number | undefined): void {
    // Echo the runner's clock: delayed replies after sleep must already be expired,
    // and runner/server wall clocks need not agree. Older runners need no ack.
    if (!isAuthoringRole(ctx.run.role) || sentAt === undefined || !Number.isFinite(sentAt)) return
    this.#d.runner.send({ type: 'run.lease', runId: ctx.run.id, leaseEpoch: ctx.run.leaseEpoch!, validUntil: new Date(sentAt + 2 * RUNNER_HEARTBEAT_MS).toISOString() }, ctx.run.runnerId)
  }
}
