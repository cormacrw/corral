import type { RunJob } from '@corral/contracts'
import { ACTIVE_RUN_STATES, errorText, isAgentPaused, leaseExpiry } from '@corral/core'
import { schema, type Database, type Executor, type PlanSessionRow, type RunRow } from '@corral/db'
import { and, asc, desc, eq, inArray, isNotNull, ne } from 'drizzle-orm'
import { ApiFailure } from './errors.ts'
import { findPmAgent } from './pm-agent.ts'
import { describeRunner, type Placement } from './placement.ts'
import type { RunContexts } from './run-context.ts'
import type { RunEnding } from './run-ending.ts'
import type { RunGate } from './run-gate.ts'
import type { PendingPmJob } from './run-job.ts'
import { STOP } from './run-stops.ts'
import type { RunnerHub } from './runner-hub.ts'

const { agents, planSessions, runs } = schema

export interface PmDispatchDeps {
  db: Database
  runner: Pick<RunnerHub, 'online' | 'name' | 'status'>
  gate: RunGate
  now(): Date
  runs: Pick<RunContexts, 'load'>
  ending: Pick<RunEnding, 'note' | 'interrupted' | 'publish'>
  placement: Pick<Placement, 'exclusive' | 'pickRunner' | 'dispatch' | 'recordRunner'>
  merges: { readonly inFlight: number }
}

export class PmDispatch {
  #d: PmDispatchDeps
  #pmStarting: Promise<void> = Promise.resolve()

  constructor(deps: PmDispatchDeps) {
    this.#d = deps
  }

  // Resolves once the turns being sent have gone
  get idle(): Promise<void> {
    return this.#pmStarting
  }

  // Also checked by design approval before it changes the version or task
  async assertPmRunPossible() {
    if (this.#d.gate.stopped) throw new ApiFailure(409, { code: 'conflict', constraint: 'corral_stopped' })
    const pm = await findPmAgent(this.#d.db)
    if (!pm) throw new ApiFailure(409, { code: 'conflict', constraint: 'no_pm_agent' })
    if (isAgentPaused(pm, this.#d.now())) throw new ApiFailure(409, { code: 'conflict', constraint: 'pm_paused' })
    return pm
  }

  // A PM turn (D9): a run with no lease of a task, fenced by its own epoch.
  // It starts right away; it only waits as `queued`, holding its job, while
  // the PM is paused, the runner can't take it, or an update is finishing (D13, D16).
  async startPmRun(session: PlanSessionRow, job: PendingPmJob): Promise<string> {
    const pm = await this.assertPmRunPossible()
    const run = await this.#d.db.transaction(tx => this.queueIn(tx, session.id, pm, job, null))
    const ctx = await this.#d.runs.load(run.id)
    if (!ctx) throw new Error('PM run vanished')
    await this.#d.ending.publish(ctx)
    await this.startPmTurns()
    return run.id
  }

  // Every PM run is created here, holding its job until it is sent. A recovery
  // triage turn names the task it is about.
  async queueIn(tx: Executor, sessionId: string, pm: { id: string }, job: PendingPmJob, taskId: string | null): Promise<RunRow> {
    // A delayed initial turn must not start after close. Serialize its run
    // insertion with the close transaction's session lock.
    const [current] = await tx.select({ closedAt: planSessions.closedAt }).from(planSessions).where(eq(planSessions.id, sessionId)).for('update')
    if (!current || current.closedAt) throw new ApiFailure(409, { code: 'conflict', constraint: 'plan_session_closed' })
    const [created] = await tx.insert(runs).values({
      agentId: pm.id, projectId: job.projectId, taskId, role: 'pm', leaseEpoch: 1, planSessionId: sessionId, pmJob: job, queuedAt: this.#d.now()
    }).returning()
    return created!
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
    const { gate } = this.#d
    if (!gate.updating || gate.finishingUpdate) return
    const workers = await this.#d.db.select({ id: runs.id }).from(runs)
      .where(and(inArray(runs.state, [...ACTIVE_RUN_STATES]), ne(runs.role, 'pm'))).limit(1)
    if (gate.updating && !workers.length && !this.#d.merges.inFlight) gate.finishingUpdate = true
  }

  async #dispatchPmTurns(): Promise<void> {
    const { db, runner, gate, placement } = this.#d
    // Set with the job, so a turn whose run.assign is lost or whose server
    // crashes here expires; every heartbeat that lists it renews it
    const leaseExpiresAt = leaseExpiry(this.#d.now())
    await this.updatePhase()
    if (!runner.online || gate.stopped || gate.finishingUpdate) return
    const due = await placement.exclusive(() => db.transaction(async (tx) => {
      const pmAgents = await tx.select().from(agents).where(eq(agents.role, 'pm')).orderBy(asc(agents.createdAt)).for('update')
      const picked: { id: string, runnerId: string, note: string | null, job: PendingPmJob }[] = []
      for (const agent of pmAgents) {
        if (isAgentPaused(agent, this.#d.now())) continue
        const waiting = await tx.select({ id: runs.id, job: runs.pmJob, planSessionId: runs.planSessionId }).from(runs)
          .where(and(eq(runs.agentId, agent.id), eq(runs.state, 'queued'), isNotNull(runs.pmJob)))
          .orderBy(asc(runs.queuedAt), asc(runs.number))
        for (const w of waiting) {
          // The runtime is the session's (D18); a job queued before sessions
          // had one runs on the PM agent's, as it always did
          const held = w.job as Omit<PendingPmJob, 'runtime'> & { runtime?: string }
          let job = { ...held, runtime: held.runtime ?? agent.runtime }
          // A Plan session stays on the runner of its earlier turns while it's
          // online: its warm process and session files are there
          const [previous] = w.planSessionId
            ? await tx.select({ runnerId: runs.runnerId, number: runs.number }).from(runs)
                .where(and(eq(runs.planSessionId, w.planSessionId), ne(runs.id, w.id), isNotNull(runs.runnerId)))
                .orderBy(desc(runs.number)).limit(1)
            : []
          const runnerId = await placement.pickRunner(tx, 'pm', job.runtime, { previous: previous?.runnerId ?? null })
          // No PM runner free: the turn keeps its job and waits
          if (!runnerId) continue
          let note: string | null = null
          if (previous && previous.runnerId !== runnerId && job.agentSessionId) {
            // Its runner is gone: cold-start a fresh session from the saved conversation
            job = { ...job, agentSessionId: null, prompt: job.fallbackPrompt ?? job.prompt, fallbackPrompt: null }
            note = `This session's earlier turns ran on ${describeRunner(runner, previous.runnerId)}, which is offline: starting a fresh session on ${describeRunner(runner, runnerId)} from the saved conversation`
          }
          await tx.update(runs).set({ pmJob: null, runnerId, leaseExpiresAt }).where(eq(runs.id, w.id))
          await placement.recordRunner(tx, w.id, runnerId)
          picked.push({ id: w.id, runnerId, note, job })
        }
      }
      return picked
    }))
    for (const { id, note, job } of due) {
      // Its job is gone from the row, so a turn that can't start must end
      // here; one bad turn must not strand the ones behind it
      const ctx = await this.#d.runs.load(id).catch((error: unknown) => {
        console.error(`Loading PM turn ${id} failed`, error)
        return null
      })
      if (!ctx) continue
      try {
        if (note) await this.#d.ending.note(id, note)
        await placement.dispatch(ctx, { ...job, runId: id, runNumber: ctx.run.number, leaseEpoch: ctx.run.leaseEpoch! } as RunJob, STOP.turnOffline)
      } catch (error) {
        console.error(`Starting PM turn ${id} failed`, error)
        await this.#d.ending.interrupted(ctx, `The turn couldn't start: ${errorText(error)}`).catch(failure => console.error(`Ending PM turn ${id} failed`, failure))
      }
    }
  }
}
