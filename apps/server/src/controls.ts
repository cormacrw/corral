import type { GlobalStatus } from '@corral/contracts'
import { ACTIVE_RUN_STATES, type Actor } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import type { EventBus } from './events.ts'
import type { PmDispatch } from './pm-dispatch.ts'
import type { RunContexts } from './run-context.ts'
import type { RunEnding } from './run-ending.ts'
import type { RunGate } from './run-gate.ts'
import { STOP } from './run-stops.ts'
import type { Scheduler } from './scheduler.ts'

const { runs, settings } = schema

export interface ControlsDeps {
  db: Database
  events: EventBus
  gate: RunGate
  now(): Date
  runs: Pick<RunContexts, 'load'>
  ending: Pick<RunEnding, 'stop'>
  scheduler: Pick<Scheduler, 'idle' | 'poke'>
  pm: Pick<PmDispatch, 'idle' | 'updatePhase'>
  merges: { readonly inFlight: number }
}

// The human's switches over the whole of Corral: the kill switch (PRD §7.11)
// and the update hold. Both set the RunGate everything that starts work reads.
export class Controls {
  #d: ControlsDeps

  constructor(deps: ControlsDeps) {
    this.#d = deps
  }

  get status(): GlobalStatus {
    return this.#d.gate.status
  }

  // Reads the kill switch; called once at startup
  async init(): Promise<void> {
    const [row] = await this.#d.db.select().from(settings).where(eq(settings.key, 'stopped'))
    this.#d.gate.stopped = row?.value === true
  }

  // The update hold drains workers/merges while PM turns still start, then
  // queues new PM turns while active turns finish. Returns the busy count so
  // the deploy can call it until that reaches zero. Kept in memory: the
  // redeployed server starts without it.
  async holdForUpdate(): Promise<number> {
    const { gate } = this.#d
    if (!gate.updating) {
      gate.updating = true
      this.#d.events.publish({ type: 'global.status', status: this.status })
    }
    // A pass that began before the hold may still be claiming
    await this.#d.scheduler.idle
    await this.#d.pm.idle
    await this.#d.pm.updatePhase()
    // PM turns still waiting for a slot keep their job and start after the update
    const live = await this.#d.db.select({ id: runs.id }).from(runs).where(and(inArray(runs.state, [...ACTIVE_RUN_STATES]), isNull(runs.pmJob)))
    return live.length + this.#d.merges.inFlight
  }

  releaseUpdate(): void {
    const { gate } = this.#d
    if (!gate.updating) return
    gate.updating = false
    gate.finishingUpdate = false
    this.#d.events.publish({ type: 'global.status', status: this.status })
    this.#d.scheduler.poke()
  }

  // Nothing new starts, and every live run is stopped. Resuming lets the
  // scheduler carry on; stopped runs retry.
  async stopAll(actor: Actor): Promise<void> {
    await this.#setStopped(true, actor)
    await this.#stopLive()
    // A pass already claiming can commit a run after that read
    await this.#d.scheduler.idle
    await this.#d.pm.idle
    await this.#stopLive()
  }

  async resumeAll(actor: Actor): Promise<void> {
    await this.#setStopped(false, actor)
    this.#d.scheduler.poke()
  }

  async #stopLive(): Promise<void> {
    const live = await this.#d.db.select({ id: runs.id }).from(runs).where(inArray(runs.state, [...ACTIVE_RUN_STATES]))
    for (const { id } of live) {
      const ctx = await this.#d.runs.load(id)
      if (!ctx) continue
      await this.#d.ending.stop(ctx, STOP.killSwitch, { reason: 'Corral was stopped', keepWork: true })
    }
  }

  async #setStopped(stopped: boolean, actor: Actor): Promise<void> {
    const { db, events } = this.#d
    this.#d.gate.stopped = stopped
    await db.insert(settings).values({ key: 'stopped', value: stopped }).onConflictDoUpdate({ target: settings.key, set: { value: stopped, updatedAt: this.#d.now() } })
    await appendAudit(db, { actor }, stopped ? auditEvent('corral.stopped', {}) : auditEvent('corral.resumed', {}))
    events.publish({ type: 'global.status', status: this.status })
  }
}
