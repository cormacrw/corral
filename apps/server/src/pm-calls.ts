import { humanTransitionInput, pmActionTools, requiresPmConfirmation } from '@corral/contracts'
import { canChangeType, isActiveRun, taskRef, type Actor } from '@corral/core'
import { schema } from '@corral/db'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { appendAudit, auditEvent } from './audit.ts'
import { getEpic, patchEpic, setEpicDependencies } from './epics.ts'
import type { Orchestrator } from './orchestrator.ts'
import { humanApprovalSummary } from './pm-approval-summary.ts'
import type { PreparedPmAction } from './pm-actions.ts'
import type { PmDecisions } from './pm-decisions.ts'
import { ToolError, type RunContext, type RunCore } from './run-context.ts'
import { addComment, createTask, loadTask, lockTask, patchTask, transitionTask } from './tasks.ts'

const { projects, tasks } = schema

// The PM's calls that change tasks, epics and the factory: what a confirm card
// proposes and does once the human agrees, and the direct edits.
export class PmCalls {
  #c: RunCore
  #o: Orchestrator

  constructor(core: RunCore, orchestrator: Orchestrator) {
    this.#c = core
    this.#o = orchestrator
  }

  async execute(tool: string, prepared: PreparedPmAction, actor: Actor): Promise<unknown> {
    const { db, events } = this.#c.d
    const o = this.#o
    switch (tool) {
      case 'delete_task':
        await o.deleteTask(prepared.targetId!, actor, prepared.input.reason as string | undefined ?? null)
        return `Deleted ${String(prepared.input.taskRef)}.`
      case 'delete_project':
        await o.deleteProject(prepared.targetId!, actor)
        return 'The project was removed.'
      case 'stop_run':
        await o.stopRun(prepared.targetId!, actor)
        return 'The run was stopped.'
      case 'set_update_hold': {
        const busy = await o.holdForUpdate()
        return { ...o.status, busy }
      }
      case 'stop_all':
        await o.stopAll(actor)
        return 'Corral is stopped.'
      case 'resume_all':
        await o.resumeAll(actor)
        return 'Corral is running again.'
    }
    if (prepared.taskId && (tool === 'approve_task' || tool === 'move_task')) {
      if (tool === 'approve_task') await this.#c.merges.humanApprove(prepared.taskId, actor)
      else {
        const event = humanTransitionInput.parse(prepared.input.transition)
        await transitionTask(db, prepared.taskId, event, actor)
        if (prepared.input.reason) await addComment(db, prepared.taskId, { body: String(prepared.input.reason), pinned: false }, actor)
      }
      const task = await loadTask(db, prepared.taskId)
      events.publish({ type: 'task.updated', task })
      this.#c.scheduler.poke([task.id])
      return tool === 'approve_task' ? `Approved ${task.ref}.` : `Moved ${task.ref} to ${task.status.replaceAll('_', ' ')}.`
    }
    return this.#c.pmDecisions.execute(tool as Parameters<PmDecisions['execute']>[0], prepared, actor)
  }

  async editEntity(ctx: RunContext, tool: 'create_task' | 'update_task' | 'update_epic', input: unknown): Promise<unknown> {
    const { db, events } = this.#c.d
    const actor = this.#c.runs.actor(ctx)
    const project = await this.#c.plans!.toolProject(ctx.run.planSessionId!, input)
    const scopedInput = z.record(z.string(), z.unknown()).parse(input)
    delete scopedInput.project
    if (tool === 'update_epic') {
      const { epicId, dependsOn, summary, ...fields } = z.object(pmActionTools.update_epic.input).strict().parse(scopedInput)
      const current = await getEpic(db, epicId)
      if (current.projectId !== project.id) throw new ToolError('Use an epic from this conversation’s project')
      await db.transaction(async (tx) => {
        await patchEpic(tx, epicId, { ...fields, ...(summary !== undefined && { description: summary }) }, actor)
        if (dependsOn !== undefined) await setEpicDependencies(tx, epicId, dependsOn, actor)
      })
      const epic = await getEpic(db, epicId)
      events.publish({ type: 'epic.updated', epic })
      for (const task of epic.tasks) events.publish({ type: 'task.updated', task })
      this.#c.scheduler.poke(epic.tasks.map(t => t.id))
      return epic
    }
    if (tool === 'create_task') {
      const parsed = z.object(pmActionTools.create_task.input).strict().parse(scopedInput)
      const task = await loadTask(db, await createTask(db, project, parsed, actor))
      events.publish({ type: 'task.created', task })
      return task
    }
    const { taskRef: ref, paused, ...fields } = z.object(pmActionTools.update_task.input).strict().parse(scopedInput)
    const match = /^([A-Za-z]+)-(\d+)$/.exec(ref)
    if (!match || match[1]!.toUpperCase() !== project.prefix.toUpperCase()) throw new ToolError('Use a task ref from this conversation’s project')
    const [row] = await db.select().from(tasks).where(and(eq(tasks.projectId, project.id), eq(tasks.number, Number(match[2])), isNull(tasks.deletedAt)))
    if (!row) throw new ToolError('Task no longer exists')
    const edit = await db.transaction(async (tx) => {
      const { task } = await lockTask(tx, row.id)
      if (paused && task.leaseRunId) throw new ToolError('Use stop_run to stop a leased task with human confirmation')
      if (fields.type && !canChangeType(task, fields.type)) throw new ToolError('A task’s type is fixed once it is approved or awaiting merge, and it can’t enter or leave the spike or design type once it has left Draft or Backlog')
      const edit = await patchTask(tx, project, row.id, fields, actor)
      if (paused !== undefined) {
        await tx.update(tasks).set({ paused, updatedAt: this.#c.now() }).where(eq(tasks.id, row.id))
        await appendAudit(tx, { projectId: project.id, taskId: row.id, actor }, paused ? auditEvent('task.paused', {}) : auditEvent('task.resumed', {}))
      }
      return edit
    })
    if (edit) await this.#c.human.noticeTaskEdit(row.id, edit, actor).catch(error => console.error('Telling the run about the PM edit failed', error))
    const task = await loadTask(db, row.id)
    events.publish({ type: 'task.updated', task })
    this.#c.scheduler.poke([row.id])
    return task
  }

  async prepare(sessionId: string, tool: string, input: unknown): Promise<PreparedPmAction> {
    if (!requiresPmConfirmation(tool, input)) throw new ToolError(`Unknown confirm-required tool ${tool}`)
    if (tool === 'act_on_inbox' || tool === 'approve_design' || tool === 'request_design_changes') return this.#c.pmDecisions.prepare(tool, input)
    if (!this.#c.plans) throw new ToolError('Planning is unavailable')
    const { db } = this.#c.d
    const [session] = await db.select().from(schema.planSessions).where(eq(schema.planSessions.id, sessionId))
    if (!session) throw new ToolError('The conversation no longer exists')
    const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict().parse(input)
    if (tool === 'delete_task' || tool === 'approve_task' || tool === 'move_task') {
      const project = await this.#c.plans.toolProject(sessionId, input)
      const parsed = z.object({ taskRef: z.string().trim().min(1), reason: z.string().optional(), transition: humanTransitionInput.optional(), project: z.string().optional() }).strict().parse(strict({ ...pmActionTools[tool].input, project: z.string().trim().min(1).optional() }))
      const match = /^([A-Za-z]+)-(\d+)$/.exec(parsed.taskRef)
      if (!match || match[1]!.toUpperCase() !== project.prefix.toUpperCase()) throw new ToolError(`Use a task ref from ${project.name}`)
      const [task] = await db.select().from(tasks).where(and(eq(tasks.projectId, project.id), eq(tasks.number, Number(match[2])), isNull(tasks.deletedAt)))
      if (!task) throw new ToolError(`Task ${parsed.taskRef} no longer exists`)
      if (tool === 'delete_task' && task.status === 'merged') throw new ToolError('Merged tasks cannot be deleted')
      if (tool === 'approve_task' && task.type === 'design') throw new ToolError('Use approve_design to approve a design')
      if (tool === 'approve_task' && task.status !== 'human_review') throw new ToolError('Task must be in Human review')
      const event = parsed.transition
      const destination = event?.type === 'resolve' ? event.to : event?.type === 'approve' ? 'ready' : event?.type === 'human_request_changes' ? 'in_progress' : 'backlog'
      const verb = tool === 'delete_task' ? 'Delete' : tool === 'approve_task' ? 'Approve' : 'Move'
      let summary = `${verb} ${taskRef(project.prefix, task.number)}${tool === 'move_task' ? ` to ${destination.replaceAll('_', ' ')}` : ''}: ${task.title}${tool === 'approve_task' ? ` (${task.prNumber ? `PR #${task.prNumber} at ` : 'head: '}${task.headSha ?? 'none'})` : ''}${event?.type === 'human_request_changes' && event.feedback ? ` — Feedback: ${event.feedback}` : ''}`
      if (tool === 'approve_task') summary += await humanApprovalSummary(db, task.id)
      return { input: { ...parsed, project: project.slug, taskRef: taskRef(project.prefix, task.number) }, summary: parsed.reason ? `${summary} — ${parsed.reason}` : summary, targetId: task.id, taskId: task.id, projectId: project.id }
    }
    switch (tool) {
      case 'delete_project': {
        const parsed = strict(pmActionTools.delete_project.input)
        const [target] = await db.select().from(projects).where(eq(projects.slug, parsed.project))
        if (!target) throw new ToolError(`Project ${parsed.project} no longer exists`)
        return { input: parsed, summary: `Remove project ${target.name} (${target.repository}) with all its tasks, runs and Plan sessions`, targetId: target.id, taskId: null, projectId: target.id }
      }
      case 'stop_run': {
        const parsed = strict(pmActionTools.stop_run.input)
        const ctx = await this.#c.runs.load(parsed.runId)
        if (!ctx) throw new ToolError('This run no longer exists')
        if (!isActiveRun(ctx.run.state)) throw new ToolError(`Run #${ctx.run.number} isn't live: it's ${ctx.run.state}`)
        const about = ctx.task ? ` on ${taskRef(ctx.project!.prefix, ctx.task.number)}: ${ctx.task.title}` : ctx.project ? ` in ${ctx.project.name}` : ' in a global conversation'
        return { input: parsed, summary: `Stop run #${ctx.run.number}, the ${ctx.run.role} run${about}`, targetId: ctx.run.id, taskId: ctx.task?.id ?? null, projectId: ctx.project?.id ?? null }
      }
      case 'set_update_hold':
        return { input: strict(pmActionTools.set_update_hold.input), summary: 'Hold Corral for an update; after running work drains, all new turns wait until you Lift the hold in the app banner', targetId: null, taskId: null, projectId: session.projectId }
      case 'stop_all':
        return { input: strict(pmActionTools.stop_all.input), summary: 'Stop every run in Corral and start no new ones', targetId: null, taskId: null, projectId: session.projectId }
      case 'resume_all':
        return { input: strict(pmActionTools.resume_all.input), summary: 'Resume Corral so runs start again', targetId: null, taskId: null, projectId: session.projectId }
    }
    throw new ToolError(`Unknown confirm-required tool ${tool}`)
  }
}
