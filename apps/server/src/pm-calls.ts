import { humanTransitionInput, isPmGatedTool, pmActionTools, pmDirectTools, requiresPmConfirmation, type PmGatedTool } from '@corral/contracts'
import { canChangeType, isActiveRun, requiresHumanReview, taskRef, type Actor } from '@corral/core'
import { schema } from '@corral/db'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { appendAudit, auditEvent } from './audit.ts'
import { ApiFailure } from './errors.ts'
import { publishInvalidatedEpics, type InvalidatedEpics } from './epic-review-state.ts'
import { getEpic, patchEpic, setEpicDependencies } from './epics.ts'
import type { Orchestrator } from './orchestrator.ts'
import { humanApprovalSummary } from './pm-approval-summary.ts'
import { resetNote } from './pm-decisions.ts'
import type { PreparedPmAction } from './pm-actions.ts'
import type { PmDecisions } from './pm-decisions.ts'
import { ToolError, type RunCore } from './run-context.ts'
import { findProjectBySlug, patchProject } from './projects.ts'
import { lostHumanChecks, lowersMode, taskReview } from './review-gates.ts'
import { addComment, createTask, loadTask, lockTask, patchTask, transitionTask } from './tasks.ts'

const { acceptanceCriteria, projects, tasks } = schema

// A card shows what will change, so a clipped value still shows its start
const VALUE_MAX = 80
const shown = (value: unknown) => {
  const text = typeof value === 'string' ? `"${value}"` : JSON.stringify(value)
  return text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX)}…` : text
}

export type PmEditTool = 'create_task' | 'update_task' | 'update_epic'

export interface PmEdit {
  result: unknown
  projectId: string
  target?: { taskId: string, taskRef: string }
  summary: string
}

// Deleting a task takes its human gates with it, so the card says which
async function lostByDeleting(db: RunCore['d']['db'], task: typeof tasks.$inferSelect): Promise<string> {
  const checks = await db.select({ text: acceptanceCriteria.text }).from(acceptanceCriteria).where(and(eq(acceptanceCriteria.taskId, task.id), eq(acceptanceCriteria.checkedByHuman, true)))
  const lost = [...(task.humanReview ? ['its human review'] : []), ...checks.map(c => `the human check "${c.text}"`)]
  return lost.length ? `. This drops ${lost.join(', ')}` : ''
}

// The PM's calls that change tasks, epics and the factory: what a confirm card
// proposes and does once the human agrees, and the direct edits.
export class PmCalls {
  #c: RunCore
  #o: Orchestrator

  constructor(core: RunCore, orchestrator: Orchestrator) {
    this.#c = core
    this.#o = orchestrator
  }

  async execute(sessionId: string, tool: string, prepared: PreparedPmAction, actor: Actor): Promise<unknown> {
    const { db, events } = this.#c.d
    const o = this.#o
    switch (tool) {
      case 'create_task':
      case 'update_task':
      case 'update_epic':
        return (await this.editEntity(sessionId, tool, prepared.input, actor)).summary
      case 'update_project': {
        const { project: slug, ...changes } = z.object(pmDirectTools.update_project.input).strict().parse(prepared.input)
        const updated = await patchProject(db, await findProjectBySlug(db, slug), changes, actor)
        events.publish({ type: 'project.updated', project: updated })
        this.#c.scheduler.poke()
        return `Changed ${updated.name}.`
      }
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
        const invalidatedEpics: InvalidatedEpics = new Map()
        await transitionTask(db, prepared.taskId, event, actor, { invalidatedEpics })
        await publishInvalidatedEpics(db, events, invalidatedEpics)
        if (prepared.input.reason) await addComment(db, prepared.taskId, { body: String(prepared.input.reason), pinned: false }, actor)
      }
      const task = await loadTask(db, prepared.taskId)
      events.publish({ type: 'task.updated', task })
      this.#c.scheduler.poke([task.id])
      return tool === 'approve_task' ? `Approved ${task.ref}.` : `Moved ${task.ref} to ${task.status.replaceAll('_', ' ')}.`
    }
    return this.#c.pmDecisions.execute(tool as Parameters<PmDecisions['execute']>[0], prepared, actor)
  }

  async editEntity(sessionId: string, tool: PmEditTool, input: unknown, actor: Actor): Promise<PmEdit> {
    const { db, events } = this.#c.d
    if (!this.#c.plans) throw new ToolError('Planning is unavailable')
    const project = await this.#c.plans.toolProject(sessionId, input)
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
      return { result: epic, projectId: project.id, summary: `Updated epic ${epic.title}` }
    }
    if (tool === 'create_task') {
      const parsed = z.object(pmActionTools.create_task.input).strict().parse(scopedInput)
      const task = await loadTask(db, await createTask(db, project, parsed, actor))
      events.publish({ type: 'task.created', task })
      return { result: task, projectId: project.id, target: { taskId: task.id, taskRef: task.ref }, summary: `Created ${task.ref}: ${task.title}` }
    }
    const { taskRef: ref, paused, ...fields } = z.object(pmActionTools.update_task.input).strict().parse(scopedInput)
    const match = /^([A-Za-z]+)-(\d+)$/.exec(ref)
    if (!match || match[1]!.toUpperCase() !== project.prefix.toUpperCase()) throw new ToolError('Use a task ref from this conversation’s project')
    const [row] = await db.select().from(tasks).where(and(eq(tasks.projectId, project.id), eq(tasks.number, Number(match[2])), isNull(tasks.deletedAt)))
    if (!row) throw new ToolError('Task no longer exists')
    const invalidatedEpics: InvalidatedEpics = new Map()
    const edit = await db.transaction(async (tx) => {
      const { task } = await lockTask(tx, row.id)
      if (paused && task.leaseRunId) throw new ToolError('Use stop_run to stop a leased task with human confirmation')
      if (fields.type && !canChangeType(task, fields.type)) throw new ToolError('A task’s type is fixed once it is approved or awaiting merge, and it can’t enter or leave the spike or design type once it has left Draft or Backlog')
      const edit = await patchTask(tx, project, row.id, fields, actor, invalidatedEpics)
      if (paused !== undefined) {
        await tx.update(tasks).set({ paused, updatedAt: this.#c.now() }).where(eq(tasks.id, row.id))
        await appendAudit(tx, { projectId: project.id, taskId: row.id, actor }, paused ? auditEvent('task.paused', {}) : auditEvent('task.resumed', {}))
      }
      return edit
    })
    await publishInvalidatedEpics(db, events, invalidatedEpics)
    if (edit) await this.#c.human.noticeTaskEdit(row.id, edit, actor).catch(error => console.error('Telling the run about the PM edit failed', error))
    const task = await loadTask(db, row.id)
    events.publish({ type: 'task.updated', task })
    this.#c.scheduler.poke([row.id])
    return { result: task, projectId: project.id, target: { taskId: task.id, taskRef: task.ref }, summary: `Updated ${task.ref}: ${task.title}` }
  }

  // Whether this edit lowers a gate. Input the tool would refuse lowers
  // nothing: the direct path reports it.
  async lowersGate(sessionId: string, tool: string, input: unknown): Promise<boolean> {
    if (!isPmGatedTool(tool)) return false
    return await this.#gateChange(sessionId, tool, input).then(change => change !== null, (error: unknown) => {
      if (error instanceof ToolError || error instanceof ApiFailure || error instanceof z.ZodError) return false
      throw error
    })
  }

  // D30: a tool never gets around a gate. What this edit lowers, in the words
  // the card uses, or null when it only raises gates or leaves them alone.
  async #gateChange(sessionId: string, tool: PmGatedTool, input: unknown): Promise<PreparedPmAction | null> {
    const { db } = this.#c.d
    const lowered: string[] = []
    const others = (changes: Record<string, unknown>, gates: readonly string[]) => Object.entries(changes).filter(([key, value]) => value !== undefined && !gates.includes(key)).map(([key, value]) => `${key} to ${shown(value)}`)
    const card = (subject: string, also: string[], target: { id: string, taskId: string | null, projectId: string }): PreparedPmAction | null => lowered.length === 0
      ? null
      : { input: input as Record<string, unknown>, summary: `Lower the gates on ${subject}: ${lowered.join('; ')}${also.length ? `. Also changes ${also.join(', ')}` : ''}`, targetId: target.id, taskId: target.taskId, projectId: target.projectId }

    if (tool === 'update_project') {
      const { project: slug, ...changes } = z.object(pmDirectTools.update_project.input).strict().parse(input)
      const [project] = await db.select().from(projects).where(eq(projects.slug, slug))
      if (!project) return null
      const removed = changes.requiredChecks ? project.requiredChecks.filter(check => !changes.requiredChecks!.includes(check)) : []
      if (removed.length) lowered.push(`stop requiring ${removed.join(', ')}`)
      if (changes.humanReviewDefault === false && project.humanReviewDefault) lowered.push('turn off human review by default')
      if (lowersMode(project.epicReviewModeDefault, changes.epicReviewModeDefault)) lowered.push(`change the default epic review mode from ${project.epicReviewModeDefault} to ${changes.epicReviewModeDefault}`)
      if (changes.reviewRoundCap !== undefined && changes.reviewRoundCap > project.reviewRoundCap) lowered.push(`raise the review round cap from ${project.reviewRoundCap} to ${changes.reviewRoundCap}`)
      if (changes.failedRunCap !== undefined && changes.failedRunCap > project.failedRunCap) lowered.push(`raise the failed run cap from ${project.failedRunCap} to ${changes.failedRunCap}`)
      if (changes.paused === false && project.paused) lowered.push('resume the paused project, which restarts its runs and merges')
      return card(project.name, others(changes, ['humanReviewDefault', 'epicReviewModeDefault', 'reviewRoundCap', 'failedRunCap', 'paused']), { id: project.id, taskId: null, projectId: project.id })
    }

    if (!this.#c.plans) return null
    const project = await this.#c.plans.toolProject(sessionId, input)
    const scoped = z.record(z.string(), z.unknown()).parse(input)
    delete scoped.project
    if (tool === 'create_task') {
      const task = z.object(pmActionTools.create_task.input).strict().parse(scoped)
      if (task.humanReview === false && project.humanReviewDefault && !requiresHumanReview(task.type, false)) lowered.push(`create it without human review, which ${project.name} has by default`)
      return card(`new task "${task.title}"`, [], { id: project.id, taskId: null, projectId: project.id })
    }
    if (tool === 'update_epic') {
      const { epicId, ...changes } = z.object(pmActionTools.update_epic.input).strict().parse(scoped)
      const epic = await getEpic(db, epicId)
      if (epic.projectId !== project.id) return null
      if (!epic.reviewModeLocked && lowersMode(epic.reviewMode, changes.reviewMode)) lowered.push(`change its review mode from ${epic.reviewMode} to ${changes.reviewMode}`)
      return card(`epic ${epic.title}`, others(changes, ['reviewMode']), { id: epic.id, taskId: null, projectId: project.id })
    }

    const { taskRef: ref, paused, ...changes } = z.object(pmActionTools.update_task.input).strict().parse(scoped)
    const match = /^([A-Za-z]+)-(\d+)$/.exec(ref)
    if (!match || match[1]!.toUpperCase() !== project.prefix.toUpperCase()) return null
    const [task] = await db.select().from(tasks).where(and(eq(tasks.projectId, project.id), eq(tasks.number, Number(match[2])), isNull(tasks.deletedAt)))
    // Merged work refuses the edit outright
    if (!task || task.status === 'merged') return null
    if (paused === false && task.paused) lowered.push('resume the paused task')
    const next = { type: changes.type ?? task.type, humanReview: changes.humanReview ?? task.humanReview }
    if (requiresHumanReview(task.type, task.humanReview) && !requiresHumanReview(next.type, next.humanReview)) lowered.push('turn off human review')
    if (changes.epicId !== undefined && changes.epicId !== task.epicId && task.prNumber === null && task.integrationProtocol === 0) {
      const modeOf = async (id: string | null) => id ? (await db.select({ mode: schema.epics.reviewMode }).from(schema.epics).where(eq(schema.epics.id, id)))[0]?.mode ?? null : null
      if (taskReview(next, await modeOf(changes.epicId)) < taskReview(task, await modeOf(task.epicId))) lowered.push('move it somewhere with less human review')
    }
    if (changes.acceptanceCriteria) {
      const held = await db.select().from(acceptanceCriteria).where(and(eq(acceptanceCriteria.taskId, task.id), eq(acceptanceCriteria.checkedByHuman, true)))
      for (const criterion of lostHumanChecks(held, changes.acceptanceCriteria)) {
        lowered.push(changes.acceptanceCriteria.some(c => c.id === criterion.id) ? `stop requiring a human for "${criterion.text}"` : `remove the human check "${criterion.text}"`)
      }
      for (const criterion of held) {
        const reworded = changes.acceptanceCriteria.find(c => c.id === criterion.id && c.text !== criterion.text && c.checkedByHuman !== false)
        if (reworded) lowered.push(`reword the human check "${criterion.text}" to "${reworded.text}"`)
      }
    }
    return card(`${taskRef(project.prefix, task.number)}: ${task.title}`, others({ ...changes, paused: paused || undefined }, ['humanReview']), { id: task.id, taskId: task.id, projectId: project.id })
  }

  async prepare(sessionId: string, tool: string, input: unknown): Promise<PreparedPmAction> {
    if (isPmGatedTool(tool)) {
      const change = await this.#gateChange(sessionId, tool, input)
      if (!change) throw new ToolError('The target of this action has changed')
      return change
    }
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
      if (tool === 'delete_task') summary += await lostByDeleting(db, task)
      if (event?.type === 'resolve') summary += resetNote(task)
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
