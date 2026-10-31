import { ACTIVE_RUN_STATES, type Actor, type RunState } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { eq } from 'drizzle-orm'
import type { AgentTools } from './agent-tools.ts'
import type { BlobStore } from './blob-store.ts'
import type { ReleaseNotes } from './deployments.ts'
import type { EpicPullRequests } from './epic-prs.ts'
import type { EventBus } from './events.ts'
import type { GitHubClient } from './github.ts'
import type { HumanActions } from './human-actions.ts'
import type { LeaseReconcile } from './lease-reconcile.ts'
import type { MergeOrchestrator } from './merge.ts'
import type { PlanService } from './plan.ts'
import type { PmDispatch } from './pm-dispatch.ts'
import type { PmTools } from './pm-tools.ts'
import type { RunEnding } from './run-ending.ts'
import type { RunExits } from './run-exits.ts'
import type { RunJobs } from './run-jobs.ts'
import type { RunOutcomes } from './run-outcomes.ts'
import type { RunnerHub } from './runner-hub.ts'
import type { Scheduler } from './scheduler.ts'
import type { ProjectRow, TaskRow } from './tasks.ts'
import type { Transcripts } from './transcripts.ts'
import type { WorktreeSweep } from './worktree-sweep.ts'

const { agents, projects, runs, tasks } = schema

export type PlanSessionRow = typeof schema.planSessions.$inferSelect
export type RunRow = typeof runs.$inferSelect
export type AgentRow = typeof agents.$inferSelect

export interface RunContext {
  run: RunRow
  agent: AgentRow
  project: ProjectRow
  task: TaskRow | null
}

export interface OrchestratorDeps {
  db: Database
  events: EventBus
  runner: RunnerHub
  github: GitHubClient
  blobs: BlobStore
  transcripts: Transcripts
  // Where people open Corral, for links in PR bodies
  publicUrl: string
  now?: () => Date
}

// What the Orchestrator's parts share: its dependencies and state, and each
// other. Built once by the Orchestrator, which is the only way in from outside.
export interface RunCore {
  d: OrchestratorDeps
  now(): Date
  // The kill switch, the update hold, and the hold's final phase
  stopped: boolean
  updating: boolean
  finishingUpdate: boolean
  // Set once the plan service exists (it needs the orchestrator to start runs)
  plans: PlanService | null
  releaseNotes: ReleaseNotes | null
  epicPrs: EpicPullRequests
  pmTools: PmTools
  merges: MergeOrchestrator
  sweep: WorktreeSweep
  runs: RunContexts
  ending: RunEnding
  jobs: RunJobs
  outcomes: RunOutcomes
  tools: AgentTools
  human: HumanActions
  pm: PmDispatch
  leases: LeaseReconcile
  exits: RunExits
  scheduler: Scheduler
}

export const server: Actor = { kind: 'system', component: 'server' }

// Stops the task is retried after, which ask the runner to keep the run's work
export const HUMAN_STOP = 'Stopped by a human'
export const KILL_SWITCH_STOP = 'Stopped: Corral was stopped'
export const KEEP_WORK_STOPS: ReadonlySet<string> = new Set([HUMAN_STOP, KILL_SWITCH_STOP])
export const RUNNER_WENT_OFFLINE = 'The runner went offline before the run started'
export const RUNNER_RESTARTED = 'The runner restarted during the run: it shut down before it could report'

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

// Thrown back to the agent as a tool error, in words it can act on
export class ToolError extends Error {}

export const errorText = (error: unknown) => error instanceof Error ? error.message : String(error)

export class RunContexts {
  #c: RunCore

  constructor(core: RunCore) {
    this.#c = core
  }

  async load(runId: string): Promise<RunContext | null> {
    // IDs come from the runner; a malformed one is simply unknown
    if (!UUID.test(runId)) return null
    const [row] = await this.#c.d.db.select({ run: runs, agent: agents, project: projects, task: tasks })
      .from(runs)
      .innerJoin(agents, eq(agents.id, runs.agentId))
      .innerJoin(projects, eq(projects.id, runs.projectId))
      .leftJoin(tasks, eq(tasks.id, runs.taskId))
      .where(eq(runs.id, runId))
    return row ?? null
  }

  // The run, if it's still live and still holds its lease at this epoch.
  // Anything from a stale run is ignored or rejected (fencing).
  async fenced(runId: string, leaseEpoch: number): Promise<RunContext | null> {
    const ctx = await this.load(runId)
    if (!ctx || ctx.run.leaseEpoch !== leaseEpoch) return null
    if (!(ACTIVE_RUN_STATES as readonly RunState[]).includes(ctx.run.state)) return null
    if (ctx.task && (ctx.task.leaseRunId !== runId || ctx.task.leaseEpoch !== leaseEpoch)) return null
    return ctx
  }

  actor(ctx: RunContext): Actor {
    return { kind: 'agent', role: ctx.run.role, runId: ctx.run.id }
  }
}
