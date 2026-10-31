import { integrationCompatibilityReason, type RunJob, type RunnerRole } from '@corral/contracts'
import { ACTIVE_RUN_STATES } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, asc, count, desc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { claimNextTask, type Claim, type Place } from './claim.ts'
import { Backoff } from './retries.ts'
import { EpicBranchError } from './task-base.ts'
import { KILL_SWITCH_STOP, RUNNER_WENT_OFFLINE, errorText, type AgentRow, type RunContext, type RunCore } from './run-context.ts'

const { agents, projects, runs, tasks } = schema

const ASSIGN_RETRY_MS = 60_000
const ASSIGN_RETRY_MAX_MS = 5 * 60_000

export class Scheduler {
  #c: RunCore
  #scheduling: Promise<void> | null = null
  #again = false
  // Tasks an event made workable (approval, a pushed PR, a review): the
  // next pass may start them even for an agent inside its wake interval
  #urgent = new Set<string>()
  // Picking a runner and recording the run on it happen one at a time, so
  // PM turns and claims never both take a runner's last slot
  #placing: Promise<unknown> = Promise.resolve()
  // Tasks whose job couldn't be prepared because GitHub didn't answer
  #assignRetry: Backoff

  constructor(core: RunCore) {
    this.#c = core
    this.#assignRetry = new Backoff(ASSIGN_RETRY_MS, ASSIGN_RETRY_MAX_MS, () => core.now())
  }

  // Resolves once the pass in flight, if any, has finished
  get idle(): Promise<void> | null {
    return this.#scheduling
  }

  // The last step of every assignment. Preparing a job can take a while, and
  // the kill switch or a human stop may have ended the run meanwhile: nothing
  // would ever stop an assignment sent after that, because the runner ignores
  // a run.stop for a run it doesn't know yet. Stops end the run before they
  // send run.stop, and there's no await between this check and the send, so
  // a stop either reaches this check or follows the assignment over the socket.
  async dispatch(ctx: RunContext, job: RunJob, offline: string): Promise<boolean> {
    const live = await this.#c.runs.fenced(ctx.run.id, ctx.run.leaseEpoch!)
    if (live && this.#c.stopped) await this.#c.ending.interrupted(live, KILL_SWITCH_STOP)
    const sent = live !== null && !this.#c.stopped && this.#c.d.runner.send({ type: 'run.assign', job }, ctx.run.runnerId)
    if (live && !sent && !this.#c.stopped) await this.#c.ending.interrupted(live, offline)
    await this.#c.ending.publish(ctx)
    return sent
  }

  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const next = this.#placing.then(fn)
    this.#placing = next.catch(() => {})
    return next
  }

  // The runner a run goes to: an online one that takes the role, has a
  // signed-in CLI for the runtime and a free slot, the emptiest first. A run
  // with a previous runner that's still online waits for that one.
  async pickRunner(tx: Executor, role: RunnerRole, runtime: string, previous: string | null, integrationProtocol = 0): Promise<string | null> {
    const fit = this.#c.d.runner.available().filter(r => r.roles.includes(role) && r.runtimes.includes(runtime) && !integrationCompatibilityReason(integrationProtocol, r.taskIntegrationProtocols))
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

  // Asks for a scheduling pass soon; passes never overlap. Passing the tasks
  // an event is about lets them start right away despite a wake interval;
  // anything else (a run ending, a settings change, the kill switch's
  // resume) waits for it
  poke(taskIds: readonly string[] = []): void {
    void this.schedule(taskIds)
  }

  async schedule(taskIds: readonly string[] = []): Promise<void> {
    for (const id of taskIds) this.#urgent.add(id)
    if (this.#scheduling) {
      this.#again = true
      return this.#scheduling
    }
    this.#scheduling = (async () => {
      do {
        this.#again = false
        await this.#schedulePass([...this.#urgent]).catch(error => console.error('Scheduling failed', error))
        await this.#dropSettledUrgent().catch(error => console.error('Scheduling failed', error))
      } while (this.#again)
    })().finally(() => {
      this.#scheduling = null
    })
    return this.#scheduling
  }

  // An urgent task stays urgent until it's claimed or can't be: a pass that
  // ended early, or found no runner slot, mustn't lose the event (flows.md step 2)
  async #dropSettledUrgent(): Promise<void> {
    const urgent = [...this.#urgent]
    if (!urgent.length) return
    const open = await this.#c.d.db.select({ id: tasks.id }).from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(inArray(tasks.id, urgent), inArray(tasks.status, ['ready', 'in_progress', 'agent_review']), isNull(tasks.leaseRunId), isNull(tasks.deletedAt), eq(tasks.paused, false), eq(projects.paused, false)))
    for (const id of urgent) {
      if (!open.some(t => t.id === id)) this.#urgent.delete(id)
    }
  }

  async #schedulePass(urgent: readonly string[]): Promise<void> {
    const { db, runner } = this.#c.d
    if (!runner.online || this.#c.stopped) return
    // PM turns aren't claimed; they run when the human writes (D9), and
    // only wait here while the PM was paused or the runner was away
    await this.#c.pm.startPmTurns()
    if (this.#c.updating) return
    await this.#c.epicPrs.reconcile()
    if (this.#c.stopped || this.#c.updating) return
    const workers = await db.select().from(agents).where(ne(agents.role, 'pm')).orderBy(asc(agents.createdAt))
    // Tasks whose run couldn't start wait for the next pass rather than
    // burning their failed-run cap in a tight loop
    const skip = this.#assignRetry.waiting()
    for (const agent of workers) {
      // One agent's failure leaves the others their turn
      try {
        await this.#scheduleAgent(agent, urgent, skip)
      } catch (error) {
        console.error(`Scheduling ${agent.name} failed`, error)
      }
      if (this.#c.stopped || this.#c.updating) return
    }
  }

  async #scheduleAgent(agent: AgentRow, urgent: readonly string[], skip: string[]): Promise<void> {
    const { db, runner } = this.#c.d
    // An agent with a wake interval starts at most one task of its own
    // choosing per interval, counted from its last run however that one
    // started. Tasks an event is about start regardless.
    if (agent.role === 'reviewer' && (agent.wakeIntervalSeconds === null || await this.#awake(agent))) {
      const claimEpic = () => this.exclusive(() => this.#c.epicPrs.claim(agent.id, tx => this.pickRunner(tx, 'reviewer', agent.runtime, null)))
      for (let job = await claimEpic(); job; job = await claimEpic()) {
        const ctx = await this.#c.runs.load(job.runId)
        if (!ctx) break
        if (ctx.run.runnerId) await this.#c.d.db.update(runs).set({ runnerName: runner.name(ctx.run.runnerId) }).where(eq(runs.id, job.runId))
        if (!await this.dispatch(ctx, job, RUNNER_WENT_OFFLINE)) break
        if (this.#c.stopped || this.#c.updating) return
        if (agent.wakeIntervalSeconds !== null) break
      }
    }
    let only = agent.wakeIntervalSeconds === null || (await this.#awake(agent)) ? undefined : urgent
    const role: RunnerRole = agent.role === 'designer' ? 'design' : agent.role
    const place: Place = async (tx, task) => {
      const previous = agent.role !== 'reviewer' ? await this.#c.jobs.previousAuthorRun(tx, task.id, agent.id, agent.role) : null
      return this.pickRunner(tx, role, agent.runtime, previous?.runnerId ?? null, task.integrationProtocol)
    }
    // With no slot on any runner that fits, a claim would lock and try every
    // ready task on every pass only to place none of them
    const claimNext = () => this.exclusive(async () => await this.pickRunner(db, role, agent.runtime, null) ? claimNextTask(db, agent.id, this.#c.now(), only, skip, place) : null)
    for (let claim = await claimNext(); claim; claim = await claimNext()) {
      if (!await this.#assign(claim)) skip.push(claim.taskId)
      if (this.#c.stopped || this.#c.updating) return
      if (agent.wakeIntervalSeconds !== null) only = urgent
    }
  }

  // Whether the agent's wake interval has passed since its last run started
  async #awake(agent: AgentRow): Promise<boolean> {
    const [last] = await this.#c.d.db.select({ queuedAt: runs.queuedAt }).from(runs)
      .where(eq(runs.agentId, agent.id)).orderBy(desc(runs.queuedAt)).limit(1)
    return !last || this.#c.now().getTime() - last.queuedAt.getTime() >= agent.wakeIntervalSeconds! * 1000
  }

  // Whether the run was handed to the runner
  async #assign(claim: Claim): Promise<boolean> {
    if (claim.runnerId) await this.#c.d.db.update(runs).set({ runnerName: this.#c.d.runner.name(claim.runnerId) }).where(eq(runs.id, claim.runId))
    const ctx = await this.#c.runs.load(claim.runId)
    if (!ctx?.task) return false
    try {
      const job = ctx.run.role === 'reviewer' ? await this.#c.jobs.reviewerJob(ctx) : ctx.run.role === 'designer' ? await this.#c.jobs.designerJob(ctx) : await this.#c.jobs.developerJob(ctx)
      const sent = await this.dispatch(ctx, job, RUNNER_WENT_OFFLINE)
      if (sent) this.#assignRetry.clear(claim.taskId)
      return sent
    } catch (error) {
      console.error(`Assigning run ${claim.runId} failed`, error)
      if (error instanceof EpicBranchError && error.transient) {
        // GitHub didn't answer, which says nothing about the task: no failed
        // run, and a while before it's tried again
        this.#assignRetry.later(claim.taskId)
        await this.#c.ending.endRun(ctx, { state: 'interrupted', error: error.message })
      } else {
        // The run fails straight away with the cause, instead of pinning its
        // agent until the lease expires and being claimed again uncounted
        await this.#c.ending.failRun(ctx, errorText(error))
      }
      await this.#c.ending.publish(ctx)
      return false
    }
  }
}
