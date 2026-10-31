import type { RunJob, PmRunJob } from '@corral/contracts'
import { ACTIVE_RUN_STATES, LEASE_DURATION_MS } from '@corral/core'
import { schema } from '@corral/db'
import { and, asc, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import { ApiFailure } from './errors.ts'
import { errorText, type PlanSessionRow, type RunCore } from './run-context.ts'

const { agents, runs } = schema

export class PmDispatch {
  #c: RunCore
  #pmStarting: Promise<void> = Promise.resolve()

  constructor(core: RunCore) {
    this.#c = core
  }

  // Resolves once the turns being sent have gone
  get idle(): Promise<void> {
    return this.#pmStarting
  }

  // Preflight design approval before it changes the version or task.
  async assertPmRunPossible() {
    if (this.#c.stopped) throw new ApiFailure(409, { code: 'conflict', constraint: 'corral_stopped' })
    const [pm] = await this.#c.d.db.select().from(agents).where(eq(agents.role, 'pm')).orderBy(asc(agents.createdAt)).limit(1)
    if (!pm) throw new ApiFailure(409, { code: 'conflict', constraint: 'no_pm_agent' })
    if (pm.paused || (pm.pausedUntil && pm.pausedUntil > this.#c.now())) throw new ApiFailure(409, { code: 'conflict', constraint: 'pm_paused' })
    return pm
  }

  // A PM turn (D9): a run with no task and no lease, fenced by its own epoch.
  // It starts right away; it only waits as `queued`, holding its job, while
  // the PM is paused, the runner can't take it, or an update is finishing (D13, D16).
  async startPmRun(session: PlanSessionRow, job: Omit<PmRunJob, 'runId' | 'runNumber' | 'leaseEpoch'>): Promise<string> {
    const { db } = this.#c.d
    const pm = await this.assertPmRunPossible()
    const [run] = await db.insert(runs).values({
      agentId: pm.id, projectId: job.projectId, taskId: null, role: 'pm', leaseEpoch: 1, planSessionId: session.id, pmJob: job, queuedAt: this.#c.now()
    }).returning()
    const ctx = await this.#c.runs.load(run!.id)
    if (!ctx) throw new Error('PM run vanished')
    await this.#c.ending.publish(ctx)
    await this.startPmTurns()
    return run!.id
  }

  // Sends every waiting PM turn to the runner, oldest first. The PM has no
  // concurrency, since each session runs one turn at a time (D9, D13), so a
  // turn waits with its job held while paused, offline, or finishing an update.
  startPmTurns(): Promise<void> {
    const next = this.#pmStarting.then(() => this.#dispatchPmTurns())
    this.#pmStarting = next.catch(() => {})
    return next
  }

  // Once workers and merges have drained, keep the phase latched until
  // release/restart. Held PM jobs must never make the deploy wait.
  async updatePhase(): Promise<void> {
    if (!this.#c.updating || this.#c.finishingUpdate) return
    const workers = await this.#c.d.db.select({ id: runs.id }).from(runs)
      .where(and(inArray(runs.state, [...ACTIVE_RUN_STATES]), ne(runs.role, 'pm'))).limit(1)
    if (this.#c.updating && !workers.length && !this.#c.merges.inFlight) this.#c.finishingUpdate = true
  }

  async #dispatchPmTurns(): Promise<void> {
    const { db, runner } = this.#c.d
    // Set with the job, so a turn whose run.assign is lost or whose server
    // crashes here expires; every heartbeat that lists it renews it
    const leaseExpiresAt = new Date(this.#c.now().getTime() + LEASE_DURATION_MS)
    await this.updatePhase()
    if (!runner.online || this.#c.stopped || this.#c.finishingUpdate) return
    const due = await this.#c.scheduler.exclusive(() => db.transaction(async (tx) => {
      const pmAgents = await tx.select().from(agents).where(eq(agents.role, 'pm')).orderBy(asc(agents.createdAt)).for('update')
      const picked: { id: string, runnerId: string, note: string | null, job: Omit<PmRunJob, 'runId' | 'runNumber' | 'leaseEpoch'> }[] = []
      for (const agent of pmAgents) {
        if (agent.paused || (agent.pausedUntil && agent.pausedUntil > this.#c.now())) continue
        const waiting = await tx.select({ id: runs.id, job: runs.pmJob, planSessionId: runs.planSessionId }).from(runs)
          .where(and(eq(runs.agentId, agent.id), eq(runs.state, 'queued'), isNotNull(runs.pmJob)))
          .orderBy(asc(runs.queuedAt), asc(runs.number))
        for (const w of waiting) {
          // The runtime is the session's (D18); a job queued before sessions
          // had one runs on the PM agent's, as it always did
          const held = w.job as Omit<PmRunJob, 'runId' | 'runNumber' | 'leaseEpoch' | 'runtime'> & { runtime?: string }
          let job = { ...held, runtime: held.runtime ?? agent.runtime }
          // A Plan session stays on the runner of its earlier turns while it's
          // online: its warm process and session files are there
          const [previous] = w.planSessionId
            ? await tx.select({ runnerId: runs.runnerId, number: runs.number }).from(runs)
                .where(and(eq(runs.planSessionId, w.planSessionId), ne(runs.id, w.id), isNotNull(runs.runnerId)))
                .orderBy(desc(runs.number)).limit(1)
            : []
          const runnerId = await this.#c.scheduler.pickRunner(tx, 'pm', job.runtime, previous?.runnerId ?? null)
          // No PM runner free: the turn keeps its job and waits
          if (!runnerId) continue
          let note: string | null = null
          if (previous && previous.runnerId !== runnerId && job.agentSessionId) {
            // Its runner is gone: cold-start a fresh session from the saved conversation
            job = { ...job, agentSessionId: null, prompt: job.fallbackPrompt ?? job.prompt, fallbackPrompt: null }
            note = `This session's earlier turns ran on ${this.#c.jobs.runnerName(previous.runnerId)}, which is offline: starting a fresh session on ${this.#c.jobs.runnerName(runnerId)} from the saved conversation`
          }
          await tx.update(runs).set({ pmJob: null, runnerId, runnerName: this.#c.d.runner.name(runnerId), leaseExpiresAt }).where(eq(runs.id, w.id))
          picked.push({ id: w.id, runnerId, note, job })
        }
      }
      return picked
    }))
    for (const { id, note, job } of due) {
      // Its job is gone from the row, so a turn that can't start must end
      // here; one bad turn must not strand the ones behind it
      const ctx = await this.#c.runs.load(id).catch(() => null)
      if (!ctx) continue
      try {
        if (note) await this.#c.ending.note(id, note)
        await this.#c.scheduler.dispatch(ctx, { ...job, runId: id, runNumber: ctx.run.number, leaseEpoch: ctx.run.leaseEpoch! } as RunJob, 'The runner went offline before the turn started')
      } catch (error) {
        console.error(`Starting PM turn ${id} failed`, error)
        await this.#c.ending.interrupted(ctx, `The turn couldn't start: ${errorText(error)}`).catch(failure => console.error(`Ending PM turn ${id} failed`, failure))
      }
    }
  }
}
