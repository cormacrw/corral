import { RUNNER_HEARTBEAT_MS, type GlobalStatus, type PmRunJob, type RunnerMessage } from '@corral/contracts'
import { ACTIVE_RUN_STATES, type Actor } from '@corral/core'
import { schema } from '@corral/db'
import { and, eq, inArray, isNull } from 'drizzle-orm'
import { AgentTools } from './agent-tools.ts'
import { appendAudit, auditEvent } from './audit.ts'
import type { ReleaseNotes } from './deployments.ts'
import { EpicPullRequests } from './epic-prs.ts'
import { HumanActions } from './human-actions.ts'
import { LeaseReconcile } from './lease-reconcile.ts'
import { MergeOrchestrator } from './merge.ts'
import type { PlanService } from './plan.ts'
import { PmDispatch } from './pm-dispatch.ts'
import { PmTools } from './pm-tools.ts'
import { KILL_SWITCH_STOP, RunContexts, type OrchestratorDeps, type PlanSessionRow, type RunCore } from './run-context.ts'
import { RunEnding } from './run-ending.ts'
import { RunExits } from './run-exits.ts'
import { RunJobs } from './run-jobs.ts'
import { RunOutcomes } from './run-outcomes.ts'
import type { RunnerHandlers } from './runner-hub.ts'
import { Scheduler } from './scheduler.ts'
import type { TaskContentEdit } from './tasks.ts'
import { WorktreeSweep } from './worktree-sweep.ts'

export { actorLabel } from './run-jobs.ts'
export { feedbackComment, findingsMarker, MAX_NOTE_LENGTH, noteProblem } from './run-outcomes.ts'
export type { OrchestratorDeps } from './run-context.ts'

const { runs, settings } = schema

// A runner reconnects within its backoff and next heartbeat. Longer than both.
const STARTUP_GRACE_MS = 3 * RUNNER_HEARTBEAT_MS
const SPOOL_SWEEP_MS = 60 * 60 * 1000

// Drives runs (flows.md §2): the runner hub's handlers and the API's way in.
// The work is in its parts: the scheduler claims and assigns, lease-reconcile
// keeps leases alive and reconciles lost runs, agent-tools and run-outcomes
// handle every agent tool call, each fenced by its lease epoch.
export class Orchestrator implements RunnerHandlers {
  #c: RunCore
  #timer: NodeJS.Timeout | null = null
  #ticking: Promise<void> | null = null
  readonly epicPrs: EpicPullRequests
  readonly pmTools: PmTools
  readonly merges: MergeOrchestrator
  readonly sweep: WorktreeSweep

  constructor(deps: OrchestratorDeps) {
    this.epicPrs = new EpicPullRequests(deps)
    this.pmTools = new PmTools({ db: deps.db, transcripts: deps.transcripts })
    this.merges = new MergeOrchestrator({
      db: deps.db,
      events: deps.events,
      github: deps.github,
      runner: deps.runner,
      wake: ids => this.poke(ids),
      epicHeadMoved: id => this.epicPrs.headMoved(id),
      ...(deps.now && { now: deps.now })
    })
    this.sweep = new WorktreeSweep({ db: deps.db, runner: deps.runner, ...(deps.now && { now: deps.now }) })
    const core = {
      d: deps,
      now: () => deps.now?.() ?? new Date(),
      stopped: false,
      updating: false,
      finishingUpdate: false,
      plans: null,
      releaseNotes: null,
      epicPrs: this.epicPrs,
      pmTools: this.pmTools,
      merges: this.merges,
      sweep: this.sweep
    } as RunCore
    core.runs = new RunContexts(core)
    core.ending = new RunEnding(core)
    core.jobs = new RunJobs(core)
    core.outcomes = new RunOutcomes(core)
    core.tools = new AgentTools(core)
    core.human = new HumanActions(core)
    core.pm = new PmDispatch(core)
    core.leases = new LeaseReconcile(core)
    core.exits = new RunExits(core)
    core.scheduler = new Scheduler(core)
    this.#c = core
  }

  get plans(): PlanService | null {
    return this.#c.plans
  }

  set plans(plans: PlanService | null) {
    this.#c.plans = plans
  }

  get releaseNotes(): ReleaseNotes | null {
    return this.#c.releaseNotes
  }

  set releaseNotes(releaseNotes: ReleaseNotes | null) {
    this.#c.releaseNotes = releaseNotes
  }

  // Reads the kill switch; called once at startup
  async init(): Promise<void> {
    const [row] = await this.#c.d.db.select().from(settings).where(eq(settings.key, 'stopped'))
    this.#c.stopped = row?.value === true
    this.merges.stopped = this.#c.stopped
  }

  get stopped(): boolean {
    return this.#c.stopped
  }

  get status(): GlobalStatus {
    return { stopped: this.#c.stopped, updating: this.#c.updating }
  }

  // The update hold drains workers/merges while PM turns still start, then
  // queues new PM turns while active turns finish. Returns the busy count so
  // the deploy can call it until that reaches zero. Kept in memory: the
  // redeployed server starts without it.
  async holdForUpdate(): Promise<number> {
    if (!this.#c.updating) {
      this.#c.updating = true
      this.merges.stopped = true
      this.#c.d.events.publish({ type: 'global.status', status: this.status })
    }
    // A pass that began before the hold may still be claiming
    await this.#c.scheduler.idle
    await this.#c.pm.idle
    await this.#c.pm.updatePhase()
    // PM turns still waiting for a slot keep their job and start after the update
    const live = await this.#c.d.db.select({ id: runs.id }).from(runs).where(and(inArray(runs.state, [...ACTIVE_RUN_STATES]), isNull(runs.pmJob)))
    return live.length + this.merges.inFlight
  }

  releaseUpdate(): void {
    if (!this.#c.updating) return
    this.#c.updating = false
    this.#c.finishingUpdate = false
    this.merges.stopped = this.#c.stopped
    this.#c.d.events.publish({ type: 'global.status', status: this.status })
    this.poke()
  }

  // The kill switch (PRD §7.11): nothing new starts, and every live run is
  // stopped. Resuming lets the scheduler carry on; stopped runs retry.
  async stopAll(actor: Actor): Promise<void> {
    await this.#setStopped(true, actor)
    await this.#stopLive()
    // A pass already claiming can commit a run after that read
    await this.#c.scheduler.idle
    await this.#c.pm.idle
    await this.#stopLive()
  }

  async #stopLive(): Promise<void> {
    const live = await this.#c.d.db.select({ id: runs.id }).from(runs).where(inArray(runs.state, [...ACTIVE_RUN_STATES]))
    for (const { id } of live) {
      const ctx = await this.#c.runs.load(id)
      if (!ctx) continue
      await this.#c.ending.interrupted(ctx, KILL_SWITCH_STOP)
      this.#c.d.runner.send({ type: 'run.stop', runId: id, reason: 'Corral was stopped', keepWork: true }, ctx.run.runnerId)
      await this.#c.ending.publish(ctx)
    }
  }

  async resumeAll(actor: Actor): Promise<void> {
    await this.#setStopped(false, actor)
    this.poke()
  }

  async #setStopped(stopped: boolean, actor: Actor): Promise<void> {
    this.#c.stopped = stopped
    this.merges.stopped = stopped || this.#c.updating
    await this.#c.d.db.insert(settings).values({ key: 'stopped', value: stopped }).onConflictDoUpdate({ target: settings.key, set: { value: stopped, updatedAt: this.#c.now() } })
    await appendAudit(this.#c.d.db, { actor }, stopped ? auditEvent('corral.stopped', {}) : auditEvent('corral.resumed', {}))
    this.#c.d.events.publish({ type: 'global.status', status: this.status })
  }

  start(intervalMs = 15_000): void {
    this.#c.leases.sweepFrom = this.#c.now().getTime() + STARTUP_GRACE_MS
    this.#timer = setInterval(() => void this.tick(), intervalMs)
    this.sweep.start()
  }

  stop(): void {
    if (this.#timer) clearInterval(this.#timer)
    this.#timer = null
    this.sweep.stop()
  }

  // One at a time: a slow GitHub call can outlast the interval, and a second
  // pass would work from older rows than the first has already acted on.
  // Silent runners are dropped even so, since they're what makes a pass slow.
  tick(): Promise<void> {
    this.#c.d.runner.dropSilent()
    this.#ticking ??= this.#tickOnce().finally(() => {
      this.#ticking = null
    })
    return this.#ticking
  }

  async #tickOnce(): Promise<void> {
    await this.sweepLeases().catch(error => console.error('Lease sweep failed', error))
    await this.merges.tick().catch(error => console.error('Merge pass failed', error))
    await this.schedule()
    if (Date.now() - this.#c.leases.spoolsSweptAt >= SPOOL_SWEEP_MS) await this.sweepSpools().catch(error => console.error('Spool sweep failed', error))
  }

  sweepLeases(): Promise<void> {
    return this.#c.leases.sweepLeases()
  }

  sweepSpools(): Promise<void> {
    return this.#c.leases.sweepSpools()
  }

  // Asks for a scheduling pass soon; see Scheduler
  poke(taskIds: readonly string[] = []): void {
    this.#c.scheduler.poke(taskIds)
  }

  schedule(taskIds: readonly string[] = []): Promise<void> {
    return this.#c.scheduler.schedule(taskIds)
  }

  refreshLoad(): Promise<void> {
    return this.#c.ending.refreshLoad()
  }

  assertPmRunPossible() {
    return this.#c.pm.assertPmRunPossible()
  }

  startPmRun(session: PlanSessionRow, job: Omit<PmRunJob, 'runId' | 'runNumber' | 'leaseEpoch'>): Promise<string> {
    return this.#c.pm.startPmRun(session, job)
  }

  stopRun(runId: string, actor: Actor): Promise<void> {
    return this.#c.human.stopRun(runId, actor)
  }

  resumeTask(taskId: string, actor: Actor): Promise<void> {
    return this.#c.human.resumeTask(taskId, actor)
  }

  messageRun(...args: Parameters<HumanActions['messageRun']>) {
    return this.#c.human.messageRun(...args)
  }

  noticeTaskEdit(taskId: string, edit: TaskContentEdit, actor: Actor): Promise<void> {
    return this.#c.human.noticeTaskEdit(taskId, edit, actor)
  }

  deleteTask(taskId: string, actor: Actor, reason: string | null): Promise<void> {
    return this.#c.human.deleteTask(taskId, actor, reason)
  }

  deleteProject(projectId: string, actor: Actor): Promise<void> {
    return this.#c.human.deleteProject(projectId, actor)
  }

  // Runner traffic

  onConnected(activeRuns: { runId: string, leaseEpoch: number }[], runnerId: string): Promise<void> {
    return this.#c.leases.onConnected(activeRuns, runnerId)
  }

  onReady(): void {
    this.poke()
    void this.releaseNotes?.sweep()
    void this.sweep.run()
  }

  onHeartbeat(activeRuns: { runId: string, leaseEpoch: number }[], runnerId: string, sentAt?: number): Promise<void> {
    return this.#c.leases.onHeartbeat(activeRuns, runnerId, sentAt)
  }

  async onDisconnected(): Promise<void> {
    // Nothing yet: leases expire on their own if the runner doesn't come back
  }

  onRunMessage(message: Extract<RunnerMessage, { type: 'run.started' | 'run.events' | 'run.ended' }>, runnerId: string): Promise<void> {
    return this.#c.exits.onRunMessage(message, runnerId)
  }

  onToolCall(message: Extract<RunnerMessage, { type: 'tool.call' }>, runnerId: string): Promise<unknown> {
    return this.#c.tools.onToolCall(message, runnerId)
  }
}
