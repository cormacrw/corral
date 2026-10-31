import { RUNTIMES_TAKING_MESSAGES, type Comment } from '@corral/contracts'
import { ACTIVE_RUN_STATES, isActiveRun, taskRef, richTextToMarkdown, type Actor } from '@corral/core'
import { schema } from '@corral/db'
import { and, asc, eq, inArray, isNull, ne } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import { ApiFailure } from './errors.ts'
import { addComment, deleteTaskRows, loadTask, type TaskContentEdit } from './tasks.ts'
import { HUMAN_STOP, type RunCore } from './run-context.ts'

const { acceptanceCriteria, attachments, projects, runs, tasks } = schema

export class HumanActions {
  #c: RunCore

  constructor(core: RunCore) {
    this.#c = core
  }

  // A human stops a run: the process tree is killed, the run is Interrupted
  // and the task is paused so the scheduler doesn't restart it (flows.md §3)
  async stopRun(runId: string, actor: Actor): Promise<void> {
    const ctx = await this.#c.runs.load(runId)
    if (!ctx || !isActiveRun(ctx.run.state)) throw new ApiFailure(409, { code: 'conflict', constraint: 'run_not_active' })
    await this.#c.d.db.transaction(async (tx) => {
      await this.#c.ending.endRunIn(tx, ctx, { state: 'interrupted', error: HUMAN_STOP })
      if (ctx.task) await tx.update(tasks).set({ paused: true }).where(eq(tasks.id, ctx.task.id))
      await appendAudit(tx, { projectId: ctx.project.id, taskId: ctx.task?.id ?? null, actor }, auditEvent('run.stopped', { runId }))
    })
    this.#c.d.runner.send({ type: 'run.stop', runId, reason: 'Stopped by a human', keepWork: true }, ctx.run.runnerId)
    await this.#c.ending.publish(ctx)
  }

  // A human lets a paused task be claimed again (flows.md §3). Only clears the
  // flag: the caller pokes the scheduler once the task is published. Throws
  // 409 task_not_paused, so a double click can't resume it twice.
  async resumeTask(taskId: string, actor: Actor): Promise<void> {
    if (actor.kind !== 'human') throw new ApiFailure(403, { code: 'forbidden' })
    await this.#c.d.db.transaction(async (tx) => {
      const [task] = await tx.update(tasks).set({ paused: false, updatedAt: this.#c.now() })
        .where(and(eq(tasks.id, taskId), eq(tasks.paused, true), isNull(tasks.deletedAt)))
        .returning({ projectId: tasks.projectId })
      if (!task) throw new ApiFailure(409, { code: 'conflict', constraint: 'task_not_paused' })
      await appendAudit(tx, { projectId: task.projectId, taskId, actor }, auditEvent('task.resumed', {}))
    })
  }

  // A human messages a live developer, designer or reviewer run. It's kept as their
  // comment on the task, with an audit entry, and sent to the runner as
  // run.message. The runner may still turn it down (e.g. a Codex run); it
  // says so in the run's transcript. Throws 409 run_not_live when no runner
  // holds the run.
  async messageRun(projectId: string, runId: string, input: { text: string, attachments: string[] }, actor: Actor): Promise<{ runId: string, comment: Comment }> {
    const { db, events, runner } = this.#c.d
    const ctx = await this.#c.runs.load(runId)
    if (!ctx || ctx.run.projectId !== projectId) throw new ApiFailure(404, { code: 'not_found' })
    const notLive = (reason: string) => new ApiFailure(409, { code: 'run_not_live', reason })
    const { run, task } = ctx
    if (!task || (run.role !== 'developer' && run.role !== 'designer' && run.role !== 'reviewer')) throw notLive(`Run #${run.number} is a ${run.role} run; only developer, designer and reviewer runs take messages`)
    if (run.state === 'queued') throw notLive(`Run #${run.number} hasn't started yet`)
    if (!isActiveRun(run.state) || run.state === 'stopping') throw notLive(`Run #${run.number} has ended`)
    if (task.leaseRunId !== run.id || task.leaseEpoch !== run.leaseEpoch) throw notLive(`Run #${run.number} no longer holds ${taskRef(ctx.project.prefix, task.number)}`)
    if (!runner.isOnline(run.runnerId)) throw notLive('No runner is connected to deliver the message')

    const found = input.attachments.length === 0
      ? []
      : await db.select({ id: attachments.id, fileName: attachments.fileName }).from(attachments)
          .where(and(eq(attachments.projectId, projectId), inArray(attachments.id, input.attachments)))
    const missing = input.attachments.filter(id => !found.some(a => a.id === id))
    if (missing.length > 0) throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['attachments'], message: `Not an attachment in this project: ${missing.join(', ')}` }] })
    // The same references as images in a comment, so get_task lists them and
    // the agent can read each with get_attachment
    const images = input.attachments.map(id => `![${found.find(a => a.id === id)!.fileName.replace(/[[\]]/g, '')}](attachment:${id})`)
    const body = [input.text, ...images].join('\n\n')

    const comment = await db.transaction(async (tx) => {
      const comment = await addComment(tx, task.id, { body, pinned: false }, actor)
      await appendAudit(tx, { projectId, taskId: task.id, actor }, auditEvent('run.message_sent', { runId: run.id, runNumber: run.number, commentId: comment.id, attachments: input.attachments }))
      // Sent last, so a runner that dropped off rolls the comment back
      if (!runner.send({ type: 'run.message', runId: run.id, leaseEpoch: run.leaseEpoch!, text: body }, run.runnerId)) {
        throw notLive('No runner is connected to deliver the message')
      }
      return comment
    })
    events.publish({ type: 'comment.created', comment })
    return { runId: run.id, comment }
  }

  // PRD §7.3: a human edited the description or criteria of a task a
  // developer, designer or reviewer run holds. A run that takes messages is told at
  // once; otherwise (Codex, not started yet, no runner) a pinned comment
  // carries the change to the agent through get_task and to the next run.
  async noticeTaskEdit(taskId: string, edit: TaskContentEdit, actor: Actor): Promise<void> {
    const { db, events } = this.#c.d
    const [task] = await db.select().from(tasks).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
    if (!task?.leaseRunId) return
    const ctx = await this.#c.runs.load(task.leaseRunId)
    if (!ctx || ctx.run.leaseEpoch !== task.leaseEpoch) return
    const { run, project } = ctx
    if (run.role !== 'developer' && run.role !== 'designer' && run.role !== 'reviewer') return
    if (!isActiveRun(run.state) || run.state === 'stopping') return

    const criteria = await db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, taskId)).orderBy(asc(acceptanceCriteria.position))
    const ref = taskRef(project.prefix, task.number)
    const what = [edit.description && 'description', edit.criteria && 'acceptance criteria'].filter(Boolean).join(' and ')
    const counts = edit.criteria
      ? [edit.criteria.added && `${edit.criteria.added} added`, edit.criteria.removed && `${edit.criteria.removed} removed`, edit.criteria.reworded && `${edit.criteria.reworded} reworded`].filter(Boolean).join(', ') || 'reordered'
      : null
    const body = (lead: string) => [
      lead,
      edit.description ? `**Description**\n\n${richTextToMarkdown(task.description) || '(no description)'}` : null,
      edit.criteria ? `**Acceptance criteria** (${counts})\n\n${criteria.map(c => `- [${c.id}] ${c.text}${c.checkedByHuman ? ' — checked by a human: skip evidence and verdict; do not request changes over it' : ''}`).join('\n') || '(none)'}` : null
    ].filter(Boolean).join('\n\n')

    if ((RUNTIMES_TAKING_MESSAGES as readonly string[]).includes(ctx.agent.runtime) && run.state !== 'queued') {
      try {
        await this.messageRun(project.id, run.id, { text: body(`The ${what} of ${ref} changed while you were working on it. Work to the new text below; evidence and verdicts go against these criterion IDs.`), attachments: [] }, actor)
        return
      } catch (error) {
        if (!(error instanceof ApiFailure) || error.status !== 409) throw error
      }
    }
    const comment = await db.transaction(async (tx) => {
      const comment = await addComment(tx, taskId, { body: body(`The ${what} of ${ref} changed during run #${run.number}, which couldn't be told while it ran. Work to the new text below.`), pinned: true }, actor)
      await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('task.edit_pinned', { runId: run.id, runNumber: run.number, commentId: comment.id }))
      return comment
    })
    events.publish({ type: 'comment.created', comment })
  }

  // D10 "Deleting": stop the run, close the PR, delete the branch when safe,
  // then hide the task. Backlog tasks are simply removed.
  async deleteTask(taskId: string, actor: Actor, reason: string | null): Promise<void> {
    const { db, github } = this.#c.d
    const [row] = await db.select({ task: tasks, project: projects }).from(tasks)
      .innerJoin(projects, eq(projects.id, tasks.projectId)).where(and(eq(tasks.id, taskId), isNull(tasks.deletedAt)))
    if (!row) throw new ApiFailure(404, { code: 'not_found' })
    const { task, project } = row
    if (task.status === 'merged') throw new ApiFailure(409, { code: 'conflict', constraint: 'merged_tasks_are_immutable' })

    // Nothing new is claimed while the PR closes, which can take a while, and
    // the run's ending pokes the scheduler. The lease is read after that.
    const [paused] = await db.update(tasks).set({ paused: true }).where(eq(tasks.id, taskId)).returning({ leaseRunId: tasks.leaseRunId })
    if (paused?.leaseRunId) {
      const ctx = await this.#c.runs.load(paused.leaseRunId)
      if (ctx) {
        await this.#c.ending.stop(ctx, 'The task was deleted', { reason: 'The task was deleted' })
      }
    }
    if (task.prNumber) {
      // The PR keeps the pushed commits reachable, so the branch can go
      await github.closePullRequest(project.repository, task.prNumber).catch(error => console.error(`Closing PR #${task.prNumber} failed`, error))
      if (task.branch) await github.deleteBranch(project.repository, task.branch).catch(error => console.error(`Deleting ${task.branch} failed`, error))
    }
    await deleteTaskRows(db, taskId, actor, reason)
    // Worktrees with uncommitted work are kept (PRD §7.4)
    if (task.status !== 'backlog') void this.#c.merges.cleanup(taskId)
    const dependents = await db.select({ id: tasks.id }).from(schema.taskDependencies)
      .innerJoin(tasks, eq(tasks.id, schema.taskDependencies.taskId)).where(eq(schema.taskDependencies.dependsOnId, taskId))
    for (const { id } of dependents) {
      const dependent = await loadTask(db, id).catch(() => null)
      if (dependent) this.#c.d.events.publish({ type: 'task.updated', task: dependent })
    }
    this.#c.d.events.publish({ type: 'task.deleted', taskId, projectId: project.id })
  }

  // design/project-settings.md, Danger zone: stop every run, then remove the
  // project and everything under it. GitHub is left alone: the repository,
  // branches and PRs stay.
  async deleteProject(projectId: string, actor: Actor): Promise<void> {
    const { db, runner } = this.#c.d
    // Nothing new is claimed while the runs stop
    await db.update(projects).set({ paused: true }).where(eq(projects.id, projectId))
    const live = await db.select({ id: runs.id }).from(runs)
      .where(and(eq(runs.projectId, projectId), inArray(runs.state, [...ACTIVE_RUN_STATES])))
    for (const { id } of live) {
      const ctx = await this.#c.runs.load(id)
      if (!ctx) continue
      await this.#c.ending.stop(ctx, 'The project was removed', { reason: 'The project was removed' })
    }
    await this.#c.ending.refreshLoad()
    const worked = await db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.projectId, projectId), ne(tasks.status, 'backlog')))
    const project = await db.transaction(async (tx) => {
      // Tasks, epics, plans, plan sessions and runs go with it (onDelete: cascade)
      const [row] = await tx.delete(projects).where(eq(projects.id, projectId)).returning()
      if (!row) throw new ApiFailure(404, { code: 'not_found' })
      // Not tied to the project, or it would go too
      await appendAudit(tx, { projectId: null, actor }, auditEvent('project.deleted', { projectId, name: row.name, repository: row.repository }))
      return row
    })
    this.#c.d.events.publish({ type: 'project.deleted', projectId })
    // Worktrees with uncommitted work are kept (PRD §7.4). The runner has no
    // hook yet for removing a repository's clone.
    for (const { id } of worked) {
      void runner.request({ kind: 'cleanup_worktrees', repository: project.repository, taskId: id })
        .catch(error => console.error(`Worktree cleanup for task ${id} failed`, error))
    }
  }
}
