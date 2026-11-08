import { toolName } from '@corral/contracts'
import { SERVER_ACTOR, taskRef } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, eq, isNotNull, isNull } from 'drizzle-orm'
import type { EventBus } from './events.ts'
import type { GitHubClient } from './github.ts'
import type { PlanSessions } from './plan-sessions.ts'
import { findPmAgent } from './pm-agent.ts'
import type { PmDispatch } from './pm-dispatch.ts'
import { pmPrompt } from './prompts.ts'
import { Backoff } from './retries.ts'
import { endStop, humanInput, REPETITION_REASON, startTriage } from './retry-recovery.ts'
import { pmJob } from './run-job.ts'
import { taskBase } from './task-base.ts'
import { addComment } from './comments.ts'
import { loadTask } from './task-views.ts'
import { lockTask } from './task-rows.ts'

const { planSessions, projects, tasks } = schema

function triagePrompt(ref: string, reason: string): string {
  return `Automatic recovery for ${ref} stopped: ${reason}. This is its one PM triage turn for this stop. Read ${toolName('get_task')}, ${toolName('list_runs')} and ${toolName('get_run')} for its failures, then inspect the relevant code and project docs. Resolve implementation problems yourself: propose concrete follow-up work with ${toolName('propose_plan')} or leave actionable findings with ${toolName('add_comment')} on ${ref}. Do not ask the human to debug or decide implementation details. Do not approve a plan, reset counters, or restart unchanged work. Only ${toolName('ask_question')} if requirements, authority or a recovery decision genuinely require the human. State what is blocked, what recovery was tried and why it stopped, the decision needed, and a recommendation (or why none is safe). Keep the recommendation in ${toolName('ask_question')}'s recommendation field. Leave a comment on ${ref} linking your findings or proposal. For a recovery question, set retryOptions to only the exact answer choices (or recommendation) that authorize retrying or continuing work. Never include leaving stopped, refusal, or clarification in retryOptions. Human plan approval still applies.`
}

export interface RecoveryPassDeps {
  db: Database
  events: EventBus
  github: GitHubClient
  runner: { readonly online: boolean }
  now(): Date
  pm: Pick<PmDispatch, 'queueIn'>
  sessions: Pick<PlanSessions, 'publish'>
  publishRun(runId: string): Promise<void>
}

// The scheduler's recovery step: releases stops whose inputs changed, and
// queues each remaining stop's one PM triage turn (D11). Durable stop
// episodes and queued PM jobs survive restarts; the task lock makes creation
// exactly once even when scheduler passes race.
export class RecoveryPass {
  #d: RecoveryPassDeps
  // How often a stop's target branch is read
  #targetPoll: Backoff

  constructor(deps: RecoveryPassDeps) {
    this.#d = deps
    this.#targetPoll = new Backoff(60_000, 5 * 60_000, deps.now)
  }

  async run(): Promise<void> {
    const { db, events } = this.#d
    // New stop markers only: deploying must not replay historical Failed tasks.
    const stopped = await db.select({ task: tasks, project: projects }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(isNull(tasks.deletedAt), isNotNull(tasks.retryStop)))
    for (const { task, project } of stopped) {
      const stop = task.retryStop!
      // Whether or not triage was queued: with no PM a stop must still release.
      const human = await humanInput(db, task.id)
      let target: string | null = null
      if (human === stop.human && this.#d.runner.online && !stop.capped && task.status !== 'blocked' && stop.target && this.#targetPoll.due(task.id)) {
        this.#targetPoll.later(task.id)
        try {
          target = await this.#d.github.branchHead(project.repository, await taskBase(db, task, project))
        } catch { /* An unavailable target is not evidence of change. */ }
      }
      if (!stop.capped && task.status !== 'blocked' && (human !== stop.human || (target && target !== stop.target))) {
        await db.transaction(async (tx) => {
          const { task: current } = await lockTask(tx, task.id)
          if (current.retryStop?.runId === stop.runId && !current.leaseRunId) await endStop(tx, task.id)
        })
        this.#targetPoll.clear(task.id)
        events.publish({ type: 'task.updated', task: await loadTask(db, task.id) })
        continue
      }
      // A human explicitly resolved a capped task through D10.
      if ((stop.capped && task.status !== 'failed') || (!stop.capped && task.status !== 'blocked' && task.status !== stop.status)) {
        await endStop(db, task.id)
        this.#targetPoll.clear(task.id)
        continue
      }
      if (stop.sessionId) continue
      const queued = await db.transaction(async (tx) => {
        const { task: locked } = await lockTask(tx, task.id)
        if (!locked.retryStop || locked.retryStop.sessionId || locked.leaseRunId) return null
        const pm = await findPmAgent(tx)
        if (!pm) return null
        const ref = taskRef(project.prefix, task.number)
        const reason = locked.statusReason ?? REPETITION_REASON
        const [session] = await tx.insert(planSessions).values({ projectId: project.id, title: `Recovery: ${ref}`, runtime: pm.runtime, createdBy: SERVER_ACTOR }).returning()
        const job = pmJob(session!, project, { prompt: pmPrompt({ fresh: true, text: triagePrompt(ref, reason), attachedTask: ref, projectName: project.name, prefix: project.prefix }), fallbackPrompt: null })
        const run = await this.#d.pm.queueIn(tx, session!.id, pm, job, task.id)
        await startTriage(tx, locked, session!.id)
        const comment = await addComment(tx, task.id, { body: `${reason}. PM triage queued as run #${run.number}. [Recovery conversation](/plan/${session!.id})`, pinned: false }, SERVER_ACTOR)
        return { run, comment }
      })
      if (queued) {
        events.publish({ type: 'comment.created', comment: queued.comment })
        await this.#d.publishRun(queued.run.id)
        await this.#d.sessions.publish(queued.run.planSessionId!)
      }
    }
  }
}
