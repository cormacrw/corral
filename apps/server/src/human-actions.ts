import type { Comment, InboxActionInput, Task } from '@corral/contracts'
import { ACTIVE_RUN_STATES, isActiveRun, RUNTIMES_TAKING_MESSAGES, roleTakesMessages, taskRef, richTextToMarkdown, type Actor } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, eq, inArray, isNull, ne } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import type { Commands } from './commands.ts'
import { publishDependents } from './dependent-tasks.ts'
import { approveDesign } from './design-approval.ts'
import { answerDecision, waitingDecision } from './epic-rebase-approval.ts'
import { publishEpic } from './epics.ts'
import { ApiFailure, notFound, requireHuman } from './errors.ts'
import { endStop, idleStop, releaseStop, stuckQuestion } from './retry-recovery.ts'
import { applyTransition, deleteTaskRows, setTaskPaused, type TaskContentEdit } from './tasks.ts'
import type { EventBus } from './events.ts'
import type { GitHubClient } from './github.ts'
import type { MergeOrchestrator } from './merge.ts'
import type { PlanService } from './plan.ts'
import type { PmDispatch } from './pm-dispatch.ts'
import type { RunContext, RunContexts } from './run-context.ts'
import type { RunEnding } from './run-ending.ts'
import { STOP } from './run-stops.ts'
import type { RunnerHub } from './runner-hub.ts'
import { addComment } from './comments.ts'
import { loadTask, loadTasks } from './task-views.ts'
import { lockTask } from './task-rows.ts'
import { ToolError } from './tool-error.ts'
import { recordSyncFailure } from './operations.ts'
import { taskCriteria } from './criteria.ts'

const { attachments, projects, runs, tasks } = schema

// A run.message no runner took, which rolls its comment back
class Undelivered extends Error {}

interface HumanActionsDeps {
  db: Database
  events: EventBus
  runner: Pick<RunnerHub, 'isOnline' | 'send' | 'cleanupWorktrees'>
  github: GitHubClient
  now(): Date
  runs: Pick<RunContexts, 'load'>
  ending: Pick<RunEnding, 'stop' | 'refreshLoad'>
  plans: Pick<PlanService, 'assertTurnPossible' | 'startDesignBuild'>
  pm: Pick<PmDispatch, 'assertPmRunPossible'>
  merges: Pick<MergeOrchestrator, 'cleanup'>
  commands: Pick<Commands, 'taskChanged' | 'approveTask' | 'transitionTask'>
  wake(taskIds?: readonly string[]): void
}

export class HumanActions {
  #d: HumanActionsDeps

  constructor(deps: HumanActionsDeps) {
    this.#d = deps
  }

  // A human stops a run: the process tree is killed, the run is Interrupted
  // and holds its task or epic fix until the human resumes it (flows.md §3)
  async stopRun(runId: string, actor: Actor): Promise<void> {
    const ctx = await this.#d.runs.load(runId)
    if (!ctx || !isActiveRun(ctx.run.state)) throw new ApiFailure(409, { code: 'conflict', constraint: 'run_not_active' })
    const stopped = await this.#d.ending.stop(ctx, STOP.human, { reason: STOP.human, keepWork: true }, {
      alsoIn: async (tx) => {
        if (ctx.task && ctx.kind !== 'pm') await tx.update(tasks).set({ paused: true }).where(eq(tasks.id, ctx.task.id))
        if (ctx.kind === 'epic_fix' && ctx.run.operationId) {
          await recordSyncFailure(tx, ctx.project!, ctx.run.epicId!, 'The developer fix was stopped by a human. Retry when ready to continue.', this.#d.now())
        }
        await appendAudit(tx, { projectId: ctx.run.projectId, taskId: ctx.task?.id ?? null, actor }, auditEvent('run.stopped', { runId }))
      }
    })
    if (!stopped) throw new ApiFailure(409, { code: 'conflict', constraint: 'run_not_active' })
  }

  // A human lets a paused task be claimed again (flows.md §3). The task is
  // what this is about, so it starts right away even inside its agent's wake
  // interval. Throws 409 task_not_paused, so a double click can't resume it twice.
  async resumeTask(taskId: string, actor: Actor): Promise<Task> {
    requireHuman(actor)
    await this.#d.db.transaction(async (tx) => {
      if (!await setTaskPaused(tx, taskId, false, actor, this.#d.now())) throw new ApiFailure(409, { code: 'conflict', constraint: 'task_not_paused' })
    })
    return this.#d.commands.taskChanged(taskId)
  }

  // A human messages a live developer, designer or reviewer run. It's kept as their
  // comment on the task, with an audit entry, and sent to the runner as
  // run.message. The runner may still turn it down (e.g. a Codex run); it
  // says so in the run's transcript. Throws 409 run_not_live when no runner
  // holds the run.
  async messageRun(projectId: string | null, runId: string, input: { text: string, attachments: string[] }, actor: Actor): Promise<{ runId: string, comment: Comment }> {
    const ctx = await this.#d.runs.load(runId)
    if (!ctx || ctx.run.projectId !== projectId) throw notFound()
    const sent = await this.#deliver(ctx, input, actor)
    if ('notLive' in sent) throw new ApiFailure(409, { code: 'run_not_live', reason: sent.notLive })
    return { runId: ctx.run.id, comment: sent.comment }
  }

  async #deliver(ctx: RunContext, input: { text: string, attachments: string[] }, actor: Actor): Promise<{ comment: Comment } | { notLive: string }> {
    const { db, events, runner } = this.#d
    const { run, task } = ctx
    const noRunner = { notLive: 'No runner is connected to deliver the message' }
    if (!task || !roleTakesMessages(run.role)) return { notLive: `Run #${run.number} is a ${run.role} run; only developer, designer and reviewer runs take messages` }
    if (run.state === 'queued') return { notLive: `Run #${run.number} hasn't started yet` }
    if (!isActiveRun(run.state)) return { notLive: `Run #${run.number} has ended` }
    if (task.leaseRunId !== run.id || task.leaseEpoch !== run.leaseEpoch) return { notLive: `Run #${run.number} no longer holds ${taskRef(ctx.project!.prefix, task.number)}` }
    if (!runner.isOnline(run.runnerId)) return noRunner

    const found = input.attachments.length === 0
      ? []
      : await db.select({ id: attachments.id, fileName: attachments.fileName }).from(attachments)
          .where(and(eq(attachments.projectId, task.projectId), inArray(attachments.id, input.attachments)))
    const missing = input.attachments.filter(id => !found.some(a => a.id === id))
    if (missing.length > 0) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['attachments'], message: `Not an attachment in this project: ${missing.join(', ')}` }] })
    // The same references as images in a comment, so get_task lists them and
    // the agent can read each with get_attachment
    const images = input.attachments.map(id => `![${found.find(a => a.id === id)!.fileName.replace(/[[\]]/g, '')}](attachment:${id})`)
    const body = [input.text, ...images].join('\n\n')

    const comment = await db.transaction(async (tx) => {
      const comment = await addComment(tx, task.id, { body, pinned: false }, actor)
      await appendAudit(tx, { projectId: task.projectId, taskId: task.id, actor }, auditEvent('run.message_sent', { runId: run.id, runNumber: run.number, commentId: comment.id, attachments: input.attachments }))
      // Sent last, so a runner that dropped off rolls the comment back
      if (!runner.send({ type: 'run.message', runId: run.id, leaseEpoch: run.leaseEpoch!, text: body }, run.runnerId)) throw new Undelivered()
      return comment
    }).catch((error: unknown) => {
      if (error instanceof Undelivered) return null
      throw error
    })
    if (!comment) return noRunner
    events.publish({ type: 'comment.created', comment })
    return { comment }
  }

  // PRD §7.3: a human edited the description or criteria of a task a
  // developer, designer or reviewer run holds. A run that takes messages is told at
  // once; otherwise (Codex, not started yet, no runner) a pinned comment
  // carries the change to the agent through get_task and to the next run.
  async noticeTaskEdit(taskId: string, edit: TaskContentEdit, actor: Actor): Promise<void> {
    const { db, events } = this.#d
    const [task] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
    if (!task?.leaseRunId) return
    const ctx = await this.#d.runs.load(task.leaseRunId)
    if (!ctx || ctx.run.leaseEpoch !== task.leaseEpoch) return
    const { run, project } = ctx
    if (!project || !roleTakesMessages(run.role)) return
    if (!isActiveRun(run.state)) return

    const current = await loadTask(db, taskId)
    const criteria = await taskCriteria(db, taskId)
    const ref = taskRef(project.prefix, task.number)
    const what = [...(edit.fields ?? []), edit.description && 'description', edit.criteria && 'acceptance criteria'].filter(Boolean).join(' and ')
    const counts = edit.criteria
      ? [edit.criteria.added && `${edit.criteria.added} added`, edit.criteria.removed && `${edit.criteria.removed} removed`, edit.criteria.reworded && `${edit.criteria.reworded} reworded`].filter(Boolean).join(', ') || 'reordered'
      : null
    const body = (lead: string) => [
      lead,
      edit.fields?.length ? `**Updated fields**\n\n${edit.fields.map(k => `${k}: ${JSON.stringify(current[k as keyof typeof current])}`).join('\n')}` : null,
      edit.description ? `**Description**\n\n${richTextToMarkdown(task.description) || '(no description)'}` : null,
      edit.criteria ? `**Acceptance criteria** (${counts})\n\n${criteria.map(c => `- [${c.id}] ${c.text}${c.checkedByHuman ? ' — checked by a human: skip evidence and verdict; do not request changes over it' : ''}`).join('\n') || '(none)'}` : null
    ].filter(Boolean).join('\n\n')

    if ((RUNTIMES_TAKING_MESSAGES as readonly string[]).includes(ctx.agent.runtime) && run.state !== 'queued') {
      const told = await this.#deliver(ctx, { text: body(`The ${what} of ${ref} changed while you were working on it. Work to the new text below; evidence and verdicts go against these criterion IDs.`), attachments: [] }, actor)
      if ('comment' in told) return
    }
    const comment = await db.transaction(async (tx) => {
      const comment = await addComment(tx, taskId, { body: body(`The ${what} of ${ref} changed during run #${run.number}, which couldn't be told while it ran. Work to the new text below.`), pinned: true }, actor)
      await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('task.edit_pinned', { runId: run.id, runNumber: run.number, commentId: comment.id }))
      return comment
    })
    events.publish({ type: 'comment.created', comment })
  }

  // design/inbox.md: what the tray does, all through D10 transitions.
  // Everything here is the human's; a PM answer goes through clarify.
  async inboxAction(taskId: string, input: InboxActionInput, actor: Actor): Promise<Task | null> {
    const { db, events } = this.#d
    const [row] = await db.select({ status: tasks.status, type: tasks.type }).from(tasks).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
    if (!row) throw notFound()
    // These release a stop where there is one. A stop has no status to resolve
    // from: Ready and In progress both carry on in place.
    const released = (input.action === 'retry' || input.action === 'resolve' || input.action === 'send_back')
      && await releaseStop(db, taskId, actor, { to: input.action === 'send_back' || (input.action === 'resolve' && input.to === 'backlog') ? 'backlog' : undefined, comment: 'text' in input ? input.text : undefined })
    if (input.action === 'retry' && !released) throw new ApiFailure(409, { code: 'conflict', constraint: null })
    if (!released) {
      switch (input.action) {
        case 'decide':
          await publishEpic(db, events, await answerDecision(db, taskId, input, actor))
          break
        case 'clarify':
          return this.clarify(taskId, input.text, actor)
        case 'send_back':
          return this.#d.commands.transitionTask(taskId, row.status === 'ready' ? { type: 'send_back' } : { type: 'resolve', to: 'backlog' }, actor)
        case 'resolve':
          return this.#d.commands.transitionTask(taskId, { type: 'resolve', to: input.to }, actor, { comment: input.text })
        case 'approve':
          if (row.type === 'design') await this.approveDesign(taskId, undefined, input.text, actor)
          else return this.#d.commands.approveTask(taskId, actor, input.text)
          break
        case 'request_changes':
          return this.#d.commands.transitionTask(taskId, { type: 'human_request_changes', feedback: input.text }, actor)
        case 'delete':
          await this.deleteTask(taskId, actor, input.text ?? null)
          return null
      }
    }
    return this.#d.commands.taskChanged(taskId)
  }

  // An answer to a Blocked task's question: a pinned comment for the
  // developer, and the task goes back In progress. The PM may only answer a
  // developer's own question (D30); a human's answer also lifts a stop or
  // decides an epic rebase's question.
  async clarify(taskId: string, text: string, actor: Actor): Promise<Task> {
    const { db, events } = this.#d
    if (actor.kind !== 'human') {
      const comment = await db.transaction(async (tx) => {
        const { task, project } = await lockTask(tx, taskId)
        if (await waitingDecision(tx, task.id)) throw new ToolError('Rebase decisions must be answered by the human in the Inbox')
        const label = taskRef(project.prefix, task.number)
        if (idleStop(task)) throw new ToolError(`${label} stopped repeating and isn't asking a question. Propose retry or resolve; those need the human.`)
        if (task.status === 'blocked' && !await stuckQuestion(tx, task.id)) throw new ToolError(`${label} is blocked by a cap, repeated review feedback or a human decision, not a developer's question, so that's the human's: propose resolve on a confirm card.`)
        const added = await addComment(tx, task.id, { body: text, pinned: true }, actor)
        await applyTransition(tx, task, project, { type: 'answer' }, actor, { event: 'answer' })
        // Answered, so the triage stop this question raised is over
        await endStop(tx, task.id)
        return added
      })
      events.publish({ type: 'comment.created', comment })
    } else if (await waitingDecision(db, taskId)) {
      await publishEpic(db, events, await answerDecision(db, taskId, { action: 'decide', text }, actor))
    } else if (!await releaseStop(db, taskId, actor, { comment: text })) {
      return this.#d.commands.transitionTask(taskId, { type: 'resolve', to: 'in_progress' }, actor, { comment: text })
    }
    return this.#d.commands.taskChanged(taskId)
  }

  // Approve a design version (D20): it's approved, earlier ones superseded,
  // and a Plan session opens for its build with the human's note. The
  // approval is a PM message, so it needs the runner like any other.
  async approveDesign(taskId: string, version: number | undefined, note: string | undefined, actor: Actor): Promise<void> {
    this.#d.plans.assertTurnPossible()
    await this.#d.pm.assertPmRunPossible()
    const versionId = await approveDesign(this.#d.db, taskId, version, actor, note)
    this.#d.wake(await publishDependents(this.#d.db, this.#d.events, taskId))
    await this.#d.plans.startDesignBuild(versionId, note, actor)
    await this.#d.commands.taskChanged(taskId)
  }

  // D10 "Deleting": stop the run, close the PR, delete the branch when safe,
  // then hide the task. Backlog tasks are simply removed.
  async deleteTask(taskId: string, actor: Actor, reason: string | null): Promise<void> {
    const { db, github } = this.#d
    const [row] = await db.select({ task: tasks, project: projects }).from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId)).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
    if (!row) throw new ApiFailure(404, { code: 'not_found' })
    const { task, project } = row
    if (task.status === 'merged') throw new ApiFailure(409, { code: 'conflict', constraint: 'merged_tasks_are_immutable' })

    // Nothing new is claimed while the PR closes, which can take a while, and
    // the run's ending pokes the scheduler. The lease is read after that.
    const [paused] = await db.update(tasks).set({ paused: true }).where(eq(tasks.id, taskId)).returning({ leaseRunId: tasks.leaseRunId })
    if (paused?.leaseRunId) {
      const ctx = await this.#d.runs.load(paused.leaseRunId)
      if (ctx) {
        await this.#d.ending.stop(ctx, STOP.taskDeleted, { reason: STOP.taskDeleted })
      }
    }
    if (task.prNumber) {
      // The PR keeps the pushed commits reachable, so the branch can go
      await github.closePullRequest(project.repository, task.prNumber).catch(error => console.error(`Closing PR #${task.prNumber} failed`, error))
      if (task.branch) await github.deleteBranch(project.repository, task.branch).catch(error => console.error(`Deleting ${task.branch} failed`, error))
    }
    await deleteTaskRows(db, taskId, actor, reason)
    // Worktrees with uncommitted work are kept (PRD §7.4)
    if (task.status !== 'backlog') void this.#d.merges.cleanup(taskId)
    const dependents = await db.select({ id: tasks.id }).from(schema.taskDependencies)
      .innerJoin(tasks, eq(tasks.id, schema.taskDependencies.taskId)).where(eq(schema.taskDependencies.dependsOnId, taskId))
    for (const dependent of await loadTasks(db, dependents.map(d => d.id))) this.#d.events.publish({ type: 'task.updated', task: dependent })
    this.#d.events.publish({ type: 'task.deleted', taskId, projectId: project.id })
  }

  // design/project-settings.md, Danger zone: stop every run, then remove the
  // project and everything under it. GitHub is left alone: the repository,
  // branches and PRs stay.
  async deleteProject(projectId: string, actor: Actor): Promise<void> {
    const { db, runner } = this.#d
    // Nothing new is claimed while the runs stop
    await db.update(projects).set({ paused: true }).where(eq(projects.id, projectId))
    const live = await db.select({ id: runs.id }).from(runs)
      .where(and(eq(runs.projectId, projectId), inArray(runs.state, [...ACTIVE_RUN_STATES])))
    for (const { id } of live) {
      const ctx = await this.#d.runs.load(id)
      if (!ctx) continue
      await this.#d.ending.stop(ctx, STOP.projectRemoved, { reason: STOP.projectRemoved })
    }
    await this.#d.ending.refreshLoad()
    const worked = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.projectId, projectId), ne(tasks.status, 'backlog')))
    const project = await db.transaction(async (tx) => {
      // Tasks, epics, plans, plan sessions and runs go with it (onDelete: cascade)
      const [row] = await tx.delete(projects).where(eq(projects.id, projectId)).returning()
      if (!row) throw new ApiFailure(404, { code: 'not_found' })
      // Not tied to the project, or it would go too
      await appendAudit(tx, { projectId: null, actor }, auditEvent('project.deleted', { projectId, name: row.name, repository: row.repository }))
      return row
    })
    this.#d.events.publish({ type: 'project.deleted', projectId })
    // Worktrees with uncommitted work are kept (PRD §7.4). The runner has no
    // hook yet for removing a repository's clone.
    for (const { id } of worked) {
      void runner.cleanupWorktrees({ kind: 'cleanup_worktrees', repository: project.repository, taskId: id })
        .catch(error => console.error(`Worktree cleanup for task ${id} failed`, error))
    }
  }
}
