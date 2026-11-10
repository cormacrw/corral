import type { RunnerMessage } from '@corral/contracts'
import type { Database } from '@corral/db'
import { AgentTools } from './agent-tools.ts'
import type { BlobStore } from './blob-store.ts'
import { Commands } from './commands.ts'
import { Controls } from './controls.ts'
import type { ReleaseNotes } from './deployments.ts'
import { EpicFixes } from './epic-fix-runs.ts'
import { EpicMerger } from './epic-merge.ts'
import { EpicPullRequests } from './epic-prs.ts'
import { EpicReviewRuns } from './epic-review-runs.ts'
import { EpicSynchronizer } from './epic-sync.ts'
import type { EventBus } from './events.ts'
import type { GitHubClient } from './github.ts'
import { HumanActions } from './human-actions.ts'
import { LeaseReconcile } from './lease-reconcile.ts'
import { MergeOrchestrator } from './merge.ts'
import { Placement } from './placement.ts'
import { PlanService } from './plan.ts'
import { PlanProposals } from './plan-proposals.ts'
import { PlanSessions } from './plan-sessions.ts'
import { PmActions } from './pm-actions.ts'
import { pmBoardTools } from './pm-board-tools.ts'
import { pmCalls } from './pm-calls.ts'
import { pmDecisions } from './pm-decisions.ts'
import { pmDirectTools } from './pm-direct-tools.ts'
import { PmDispatch } from './pm-dispatch.ts'
import { PmTools } from './pm-tools.ts'
import { RecoveryPass } from './recovery-pass.ts'
import { RunContexts } from './run-context.ts'
import { RunEnding } from './run-ending.ts'
import { RunExits } from './run-exits.ts'
import { RunGate } from './run-gate.ts'
import { RunJobs } from './run-jobs.ts'
import { RunOutcomes } from './run-outcomes.ts'
import { RUNNER_STALE_MS, type RunnerHandlers, type RunnerHub } from './runner-hub.ts'
import { Scheduler } from './scheduler.ts'
import { TaskIntegrator } from './task-integration.ts'
import type { Transcripts } from './transcripts.ts'
import { WorktreeSweep } from './worktree-sweep.ts'

interface OrchestratorDeps {
  db: Database
  events: EventBus
  runner: RunnerHub
  github: GitHubClient
  blobs: BlobStore
  transcripts: Transcripts
  releaseNotes: ReleaseNotes
  // Where people open Corral, for links in PR bodies
  publicUrl: string
  now?: () => Date
}

type ActiveRuns = { runId: string, leaseEpoch: number }[]

// Drives runs (flows.md §2). Only wires the parts together, each with what it
// calls, and runs the timer; routes call the part that owns what they do. The
// scheduler claims and assigns, lease-reconcile keeps leases alive and
// reconciles lost runs, agent-tools and run-outcomes handle every agent tool
// call, each fenced by its lease epoch, and run-ending owns how runs end.
export class Orchestrator implements RunnerHandlers {
  readonly gate = new RunGate()
  readonly runs: RunContexts
  readonly ending: RunEnding
  readonly placement: Placement
  readonly jobs: RunJobs
  readonly outcomes: RunOutcomes
  readonly epicPrs: EpicPullRequests
  readonly epicReviews: EpicReviewRuns
  readonly fixes: EpicFixes
  readonly merges: MergeOrchestrator
  readonly integrations: TaskIntegrator
  readonly epicMerges: EpicMerger
  readonly sweep: WorktreeSweep
  readonly commands: Commands
  readonly sessions: PlanSessions
  readonly proposals: PlanProposals
  readonly plans: PlanService
  readonly pm: PmDispatch
  readonly human: HumanActions
  readonly recovery: RecoveryPass
  readonly scheduler: Scheduler
  readonly controls: Controls
  readonly pmActions: PmActions
  readonly pmTools: PmTools
  readonly leases: LeaseReconcile
  readonly exits: RunExits
  readonly tools: AgentTools
  #runner: RunnerHub
  #releaseNotes: ReleaseNotes
  #now: () => Date
  #timer: NodeJS.Timeout | null = null
  #ticking: Promise<void> | null = null

  constructor(deps: OrchestratorDeps) {
    const { db, events, runner, github, blobs, transcripts, publicUrl } = deps
    const now = () => deps.now?.() ?? new Date()
    const gate = this.gate
    // The scheduler is built last; the parts before it only wake it later
    const wake = (taskIds: readonly string[] = []) => this.scheduler.poke(taskIds)
    this.#runner = runner
    this.#releaseNotes = deps.releaseNotes
    this.#now = now

    const runs = this.runs = new RunContexts(db)
    const epicPrs = this.epicPrs = new EpicPullRequests({ db, events, github, publicUrl, now })
    const epicReviews = this.epicReviews = new EpicReviewRuns({ db, events, github, now })
    // Three passes merge work: task PRs, PR-free subtasks onto their task's
    // branch (which the synchronizer keeps on its target), and tasks' own PRs
    const merges = this.merges = new MergeOrchestrator({ db, events, github, runner, gate, now, wake })
    const settled = (taskId: string) => merges.settled(taskId)
    const sync = new EpicSynchronizer({ db, events, github, runner, gate, now, wake })
    const integrations = this.integrations = new TaskIntegrator({ db, events, github, runner, gate, now, wake, sync, settled })
    const epicMerges = this.epicMerges = new EpicMerger({ db, events, github, runner, gate, now, wake, headMoved: id => epicPrs.headMoved(id) })
    // A redeploy waits for merges in flight in any of them
    const merging = {
      get inFlight() {
        return merges.inFlight + integrations.inFlight + epicMerges.inFlight
      }
    }
    this.sweep = new WorktreeSweep({ db, runner, now })
    const commands = this.commands = new Commands({ db, events, blobs, runner, merges, now, wake, noticeTaskEdit: (taskId, edit, actor) => this.human.noticeTaskEdit(taskId, edit, actor) })
    const sessions = this.sessions = new PlanSessions(db, events)
    const proposals = this.proposals = new PlanProposals({ db, events, sessions, wake })
    // A Plan session's turns are PM runs, and closing one stops its run
    const plans = this.plans = new PlanService({
      db, events, runner, sessions, proposals,
      recoveryReady: taskIds => void this.scheduler.schedule(taskIds),
      stopRun: (runId, actor) => this.human.stopRun(runId, actor),
      startRun: (session, job) => this.pm.startPmRun(session, job)
    })
    const ending = this.ending = new RunEnding({ db, events, runner, transcripts, github, now, runs, plans, epicPrs, epicReviews, wake })
    const placement = this.placement = new Placement({ runner, gate, runs, ending })
    const jobs = this.jobs = new RunJobs({ db, github, runner, now, ending })
    const outcomes = this.outcomes = new RunOutcomes({ db, events, github, blobs, publicUrl, runs, ending })
    const fixes = this.fixes = new EpicFixes({ db, github, now, ending, publishEpic: id => epicPrs.publish(id) })
    const pm = this.pm = new PmDispatch({ db, runner, gate, now, runs, ending, placement, merges: merging })
    const human = this.human = new HumanActions({ db, events, runner, github, now, runs, ending, plans, pm, merges, commands, wake })
    const recovery = this.recovery = new RecoveryPass({
      db, events, github, runner, now, pm, sessions,
      publishRun: async (runId) => {
        const ctx = await runs.load(runId)
        if (ctx) await ending.publish(ctx)
      }
    })
    const scheduler = this.scheduler = new Scheduler({ db, github, runner, gate, now, runs, ending, placement, jobs, epicPrs, epicReviews, fixes, pm, recovery })
    const controls = this.controls = new Controls({ db, events, gate, now, runs, ending, scheduler, pm, merges: merging })
    // Every PM tool, and the cards of those that ask the human first (D30)
    const pmTools = this.pmTools = new PmTools({
      db,
      propose: (sessionId, runId, tool, prepared, actor) => this.pmActions.propose(sessionId, runId, tool, prepared, actor),
      handlers: {
        ...pmBoardTools({ db, blobs, sessions, proposals, commands }),
        ...pmDirectTools({ db, runner, transcripts, controls, human, plans, commands }),
        ...pmCalls({ db, runs, human, controls, commands }),
        ...pmDecisions({ db, human })
      }
    })
    this.pmActions = new PmActions({ db, events, sessions, tools: pmTools })
    const leases = this.leases = new LeaseReconcile({ db, runner, transcripts, now, runs, ending })
    this.exits = new RunExits({ db, events, transcripts, now, runs, ending, leases, plans, wake })
    this.tools = new AgentTools({ db, blobs, publicUrl, runs, ending, jobs, outcomes, fixes, epicReviews, pmTools })
  }

  // Called once at startup
  async init(): Promise<void> {
    await this.pmActions.recoverInterrupted()
    await this.controls.init()
  }

  start(intervalMs = 15_000): void {
    // A runner reconnects within its backoff and next heartbeat, so within the time a silent one is dropped
    this.leases.sweepFrom = this.#now().getTime() + RUNNER_STALE_MS
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
    this.#runner.dropSilent()
    this.#ticking ??= this.#tickOnce().finally(() => {
      this.#ticking = null
    })
    return this.#ticking
  }

  async #tickOnce(): Promise<void> {
    await this.leases.sweepLeases().catch(error => console.error('Lease sweep failed', error))
    await this.mergePass().catch(error => console.error('Merge pass failed', error))
    await this.scheduler.schedule()
    if (this.leases.spoolSweepDue()) await this.leases.sweepSpools().catch(error => console.error('Spool sweep failed', error))
  }

  async mergePass(): Promise<void> {
    if (this.gate.halted || !this.#runner.online) return
    await this.merges.tick()
    if (this.gate.halted) return
    await this.integrations.tick()
    await this.epicMerges.tick()
  }

  onConnected(activeRuns: ActiveRuns, runnerId: string): Promise<void> {
    return this.leases.onConnected(activeRuns, runnerId)
  }

  onReady(): void {
    this.scheduler.poke()
    void this.#releaseNotes.sweep()
    void this.sweep.run()
  }

  onHeartbeat(activeRuns: ActiveRuns, runnerId: string, sentAt?: number): Promise<void> {
    return this.leases.onHeartbeat(activeRuns, runnerId, sentAt)
  }

  onRunMessage(message: Extract<RunnerMessage, { type: 'run.started' | 'run.events' | 'run.ended' }>, runnerId: string): Promise<void> {
    return this.exits.onRunMessage(message, runnerId)
  }

  onToolCall(message: Extract<RunnerMessage, { type: 'tool.call' }>, runnerId: string): Promise<unknown> {
    return this.tools.onToolCall(message, runnerId)
  }
}
