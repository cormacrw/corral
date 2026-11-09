import { runnerRoleFor } from '@corral/contracts'
import { errorText } from '@corral/core'
import { schema, type Database, type AgentRow } from '@corral/db'
import { and, asc, desc, eq, inArray, ne } from 'drizzle-orm'
import { claimable, claimNextTask, type Claim, type Place } from './claim.ts'
import type { EpicFixes } from './epic-fix-runs.ts'
import type { EpicPullRequests } from './epic-prs.ts'
import type { EpicReviewRuns } from './epic-review-runs.ts'
import type { GitHubClient } from './github.ts'
import type { Placement } from './placement.ts'
import type { PmDispatch } from './pm-dispatch.ts'
import type { RecoveryPass } from './recovery-pass.ts'
import { retryContext } from './retry-recovery.ts'
import { Backoff, RETRY_MAX_MS } from './retries.ts'
import type { RunContexts } from './run-context.ts'
import type { RunEnding } from './run-ending.ts'
import type { RunGate } from './run-gate.ts'
import type { RunJobs } from './run-jobs.ts'
import { STOP } from './run-stops.ts'
import { RunnerDisconnected, type RunnerHub } from './runner-hub.ts'
import { ApiFailure } from './errors.ts'
import { GitHubError, isTransient } from './github.ts'
import { EpicBranchError } from './task-base.ts'

const { agents, projects, runs, tasks } = schema

const ASSIGN_RETRY_MS = 60_000

interface SchedulerDeps {
  db: Database
  github: GitHubClient
  runner: Pick<RunnerHub, 'online' | 'name'>
  gate: RunGate
  now(): Date
  runs: Pick<RunContexts, 'load'>
  ending: Pick<RunEnding, 'endRun' | 'failRun' | 'publish'>
  placement: Placement
  jobs: Pick<RunJobs, 'developerJob' | 'designerJob' | 'reviewerJob' | 'previousAuthorRun'>
  epicPrs: Pick<EpicPullRequests, 'reconcile' | 'publish'>
  epicReviews: Pick<EpicReviewRuns, 'claim' | 'addCiResult'>
  fixes: Pick<EpicFixes, 'claim' | 'job'>
  pm: Pick<PmDispatch, 'startPmTurns'>
  recovery: Pick<RecoveryPass, 'run'>
}

// Whether a run that couldn't start was let down by GitHub or a runner, which
// says nothing about its work. Anything else is the run's own failure.
function notStartedYet(error: unknown): boolean {
  if (error instanceof EpicBranchError || error instanceof GitHubError) return isTransient(error)
  return error instanceof RunnerDisconnected || (error instanceof ApiFailure && error.body.code === 'runner_offline')
}

export class Scheduler {
  #d: SchedulerDeps
  #scheduling: Promise<void> | null = null
  #again = false
  // Tasks an event made workable (approval, a pushed PR, a review): the
  // next pass may start them even for an agent inside its wake interval
  #urgent = new Set<string>()
  // Tasks whose job couldn't be prepared because GitHub didn't answer
  #assignRetry: Backoff

  constructor(deps: SchedulerDeps) {
    this.#d = deps
    this.#assignRetry = new Backoff(ASSIGN_RETRY_MS, RETRY_MAX_MS, deps.now)
  }

  // Resolves once the pass in flight, if any, has finished
  get idle(): Promise<void> | null {
    return this.#scheduling
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
    const open = await this.#d.db.select({ id: tasks.id }).from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(inArray(tasks.id, urgent), claimable()))
    for (const id of urgent) {
      if (!open.some(t => t.id === id)) this.#urgent.delete(id)
    }
  }

  async #schedulePass(urgent: readonly string[]): Promise<void> {
    const { db, runner, gate } = this.#d
    if (gate.stopped) return
    await this.#d.recovery.run()
    if (!runner.online) return
    // PM turns aren't claimed; they run when the human writes (D9), and
    // only wait here while the PM was paused or the runner was away
    await this.#d.pm.startPmTurns()
    if (gate.updating) return
    await this.#d.epicPrs.reconcile()
    if (gate.halted) return
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
      if (this.#d.gate.halted) return
    }
  }

  async #scheduleAgent(agent: AgentRow, urgent: readonly string[], skip: string[]): Promise<void> {
    const { db, placement } = this.#d
    // An agent with a wake interval starts at most one task of its own
    // choosing per interval, counted from its last run however that one
    // started. Tasks an event is about start regardless.
    if (agent.role === 'reviewer' && (agent.wakeIntervalSeconds === null || await this.#awake(agent))) {
      const claimEpic = () => placement.exclusive(() => this.#d.epicReviews.claim(agent.id, tx => placement.pickRunner(tx, 'reviewer', agent.runtime)))
      for (let job = await claimEpic(); job; job = await claimEpic()) {
        const ctx = await this.#d.runs.load(job.runId)
        if (!ctx) break
        await placement.recordRunner(db, job.runId, ctx.run.runnerId)
        if (!await placement.dispatch(ctx, await this.#d.epicReviews.addCiResult(job, ctx.project!.requiredChecks), STOP.runnerOffline)) break
        if (this.#d.gate.halted) return
        if (agent.wakeIntervalSeconds !== null) break
      }
    }
    if (agent.role === 'developer' && (agent.wakeIntervalSeconds === null || await this.#awake(agent))) {
      const claimFix = () => placement.exclusive(() => this.#d.fixes.claim(agent.id, tx => placement.pickRunner(tx, 'developer', agent.runtime), skip))
      for (let runId = await claimFix(); runId; runId = await claimFix()) {
        await this.#assignFix(runId, skip)
        if (this.#d.gate.halted) return
        if (agent.wakeIntervalSeconds !== null) break
      }
    }
    let only = agent.wakeIntervalSeconds === null || (await this.#awake(agent)) ? undefined : urgent
    const role = runnerRoleFor(agent.role)
    const place: Place = async (tx, task) => {
      const previous = agent.role !== 'reviewer' ? await this.#d.jobs.previousAuthorRun(tx, task.id, agent.id, agent.role) : null
      return placement.pickRunner(tx, role, agent.runtime, previous?.runnerId ?? null)
    }
    // With no slot on any runner that fits, a claim would lock and try every
    // ready task on every pass only to place none of them
    const claimNext = () => placement.exclusive(async () => await placement.pickRunner(db, role, agent.runtime) ? claimNextTask(db, agent.id, this.#d.now(), only, skip, place) : null)
    for (let claim = await claimNext(); claim; claim = await claimNext()) {
      if (!await this.#assign(claim)) skip.push(claim.taskId)
      if (this.#d.gate.halted) return
      if (agent.wakeIntervalSeconds !== null) only = urgent
    }
  }

  // Whether the agent's wake interval has passed since its last run started
  async #awake(agent: AgentRow): Promise<boolean> {
    const [last] = await this.#d.db.select({ queuedAt: runs.queuedAt }).from(runs)
      .where(eq(runs.agentId, agent.id)).orderBy(desc(runs.queuedAt)).limit(1)
    return !last || this.#d.now().getTime() - last.queuedAt.getTime() >= agent.wakeIntervalSeconds! * 1000
  }

  // A developer run on an epic (D29). If it can't start for a reason that says
  // nothing about the fix, the epic waits for a later pass, as a task does.
  // Otherwise it fails with the cause, counting towards the fix's bound, rather
  // than pinning its agent until the lease expires.
  async #assignFix(runId: string, skip: string[]): Promise<void> {
    const { db } = this.#d
    const ctx = await this.#d.runs.load(runId)
    if (!ctx) return
    await this.#d.placement.recordRunner(db, runId, ctx.run.runnerId)
    const epicId = ctx.run.epicId!
    try {
      if (await this.#d.placement.dispatch(ctx, await this.#d.fixes.job(ctx), STOP.runnerOffline)) this.#assignRetry.clear(epicId)
      else {
        this.#assignRetry.later(epicId)
        skip.push(epicId)
      }
    } catch (error) {
      console.error(`Assigning run ${runId} failed`, error)
      skip.push(epicId)
      if (notStartedYet(error)) {
        this.#assignRetry.later(epicId)
        await this.#d.ending.endRun(ctx, { state: 'interrupted', error: STOP.fixNotStarted })
      } else await this.#d.ending.failRun(ctx, errorText(error))
      await this.#d.ending.publish(ctx)
    }
    await this.#d.epicPrs.publish(epicId)
  }

  // Whether the run was handed to the runner
  async #assign(claim: Claim): Promise<boolean> {
    await this.#d.placement.recordRunner(this.#d.db, claim.runId, claim.runnerId)
    const ctx = await this.#d.runs.load(claim.runId)
    if (!ctx?.task) return false
    try {
      const job = ctx.run.role === 'reviewer' ? await this.#d.jobs.reviewerJob(ctx) : ctx.run.role === 'designer' ? await this.#d.jobs.designerJob(ctx) : await this.#d.jobs.developerJob(ctx)
      const context = await retryContext(this.#d, ctx)
      await this.#d.db.update(runs).set({ retryContext: context }).where(eq(runs.id, ctx.run.id))
      ctx.run.retryContext = context
      const sent = await this.#d.placement.dispatch(ctx, job, STOP.runnerOffline)
      if (sent) this.#assignRetry.clear(claim.taskId)
      return sent
    } catch (error) {
      console.error(`Assigning run ${claim.runId} failed`, error)
      if (notStartedYet(error)) {
        // GitHub or the runner didn't answer, which says nothing about the
        // task: no failed run, and a while before it's tried again
        this.#assignRetry.later(claim.taskId)
        await this.#d.ending.endRun(ctx, { state: 'interrupted', error: errorText(error) })
      } else {
        // The run fails straight away with the cause, instead of pinning its
        // agent until the lease expires and being claimed again uncounted
        await this.#d.ending.failRun(ctx, errorText(error))
      }
      await this.#d.ending.publish(ctx)
      return false
    }
  }
}
