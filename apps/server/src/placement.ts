import { integrationCompatibilityReason, type RunJob, type RunnerRole } from '@corral/contracts'
import { ACTIVE_RUN_STATES } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, count, eq, inArray } from 'drizzle-orm'
import type { RunContext, RunContexts } from './run-context.ts'
import type { RunEnding } from './run-ending.ts'
import type { RunGate } from './run-gate.ts'
import { STOP } from './run-stops.ts'
import type { RunnerHub } from './runner-hub.ts'

const { runs } = schema

// A runner as a transcript note names it
export function describeRunner(runner: Pick<RunnerHub, 'status'>, runnerId: string | null): string {
  const name = runner.status().runners.find(r => r.id === runnerId)?.name
  return name ? `runner ${name}` : 'a runner this server no longer knows'
}

interface PlacementDeps {
  runner: Pick<RunnerHub, 'available' | 'send' | 'name'>
  gate: Pick<RunGate, 'stopped'>
  runs: Pick<RunContexts, 'fenced'>
  ending: Pick<RunEnding, 'interrupted' | 'publish'>
}

// Which runner a run goes to, and handing it over. Picking a runner and
// recording the run on it happen one at a time, so PM turns and claims never
// both take a runner's last slot.
export class Placement {
  #d: PlacementDeps
  #placing: Promise<unknown> = Promise.resolve()

  constructor(deps: PlacementDeps) {
    this.#d = deps
  }

  // A placed run keeps its runner's name, for once that runner is gone
  async recordRunner(db: Executor, runId: string, runnerId: string | null): Promise<void> {
    if (runnerId) await db.update(runs).set({ runnerName: this.#d.runner.name(runnerId) }).where(eq(runs.id, runId))
  }

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#placing.then(fn)
    this.#placing = next.catch(() => {})
    return next
  }

  // An online runner that takes the role, has a signed-in CLI for the runtime
  // and a free slot, the emptiest first. A run with a previous runner that's
  // still online waits for that one.
  async pickRunner(tx: Executor, role: RunnerRole, runtime: string, options: { previous?: string | null, integrationProtocol?: number, epicFix?: boolean } = {}): Promise<string | null> {
    const { previous = null, integrationProtocol = 0, epicFix = false } = options
    const fit = this.#d.runner.available().filter(r => !r.toolContractReason && r.roles.includes(role) && r.runtimes.includes(runtime) && !integrationCompatibilityReason(integrationProtocol, r.taskIntegrationProtocols) && (!epicFix || r.epicFixExecutor))
    if (!fit.length) return null
    const busy = await tx.select({ runnerId: runs.runnerId, n: count() }).from(runs)
      .where(and(inArray(runs.state, [...ACTIVE_RUN_STATES]), inArray(runs.runnerId, fit.map(r => r.id))))
      .groupBy(runs.runnerId)
    const free = (id: string, slots: number) => slots - (busy.find(b => b.runnerId === id)?.n ?? 0)
    const sticky = previous ? fit.find(r => r.id === previous) : undefined
    if (sticky) return free(sticky.id, sticky.slots) > 0 ? sticky.id : null
    const best = fit.map(r => ({ id: r.id, free: free(r.id, r.slots) })).filter(r => r.free > 0)
      .sort((a, b) => b.free - a.free)[0]
    return best?.id ?? null
  }

  // The last step of every assignment. Preparing a job can take a while, and
  // the kill switch or a human stop may have ended the run meanwhile: nothing
  // would ever stop an assignment sent after that, because the runner ignores
  // a run.stop for a run it doesn't know yet. Stops end the run before they
  // send run.stop, and there's no await between this check and the send, so
  // a stop either reaches this check or follows the assignment over the socket.
  async dispatch(ctx: RunContext, job: RunJob, offline: string): Promise<boolean> {
    const live = await this.#d.runs.fenced(ctx.run.id, ctx.run.leaseEpoch!)
    if (live && this.#d.gate.stopped) await this.#d.ending.interrupted(live, STOP.killSwitch)
    const sent = live !== null && !this.#d.gate.stopped && this.#d.runner.send({ type: 'run.assign', job }, ctx.run.runnerId)
    if (live && !sent && !this.#d.gate.stopped) await this.#d.ending.interrupted(live, offline)
    await this.#d.ending.publish(ctx)
    return sent
  }
}
