import { epicReviewReportSchema, isPmDirectTool, pmActionTools, pmDirectTools, requiresPmConfirmation, evidenceInputSchema, outcomeReportSchema, rebaseReviewReportSchema, type RunnerMessage } from '@corral/contracts'
import { taskRef, richTextToMarkdown } from '@corral/core'
import { schema } from '@corral/db'
import { and, asc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { listTaskAttachments, readProjectAttachment } from './attachments.ts'
import { DesignNotFound, readDesign } from './designs.ts'
import { epicReviewContext } from './epic-prs.ts'
import { ApiFailure } from './errors.ts'
import { listEvidence } from './runs.ts'
import { listTaskSubmissions } from './task-submissions.ts'
import { findTaskByRef } from './tasks.ts'
import { ToolError, type RunContext, type RunCore } from './run-context.ts'

const { acceptanceCriteria, comments, evidence, tasks } = schema

// A report that doesn't fit its schema comes back to the agent field by field
function parseReport<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed.data
  const fields = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
  throw new ToolError(`Not reported. ${fields.join('. ')}. Fix this and report again.`)
}

const MAX_EVIDENCE_BYTES = 25 * 1024 * 1024

const IMAGE_TYPES = /^image\/(png|jpeg|gif|webp)$/

// Text evidence is returned inline up to this size
const MAX_INLINE_TEXT = 64 * 1024

// A file, or a note on its own: written evidence for a criterion with
// nothing to show (D21)
const evidenceSchema = evidenceInputSchema

export class AgentTools {
  #c: RunCore

  constructor(core: RunCore) {
    this.#c = core
  }

  async onToolCall(message: Extract<RunnerMessage, { type: 'tool.call' }>, runnerId: string): Promise<unknown> {
    const ctx = await this.#c.runs.fenced(message.runId, message.leaseEpoch)
    if (!ctx || ctx.run.runnerId !== runnerId) throw new ToolError('This run no longer holds its task: its lease expired or was given to another run. Stop working.')
    try {
      return await this.#tool(ctx, message.tool, message.input)
    } catch (error) {
      if (error instanceof ApiFailure && error.body.code === 'transition_rejected') {
        throw new ToolError(`Corral rejected this: ${JSON.stringify(error.body.reason)}`)
      }
      throw error
    }
  }

  async #tool(ctx: RunContext, tool: string, input: unknown): Promise<unknown> {
    const role = ctx.run.role
    const allowed: Record<string, readonly string[]> = {
      developer: ['get_task', 'add_comment', 'attach_evidence', 'get_attachment', 'get_design', 'report_outcome'],
      designer: ['get_task', 'add_comment', 'attach_evidence', 'get_attachment', 'get_design', 'submit_design', 'report_outcome'],
      reviewer: ['get_task', 'add_comment', 'get_evidence', 'get_attachment', 'get_design', 'report_outcome'],
      pm: ['attach_evidence', 'list_tasks', 'get_task', 'add_comment', 'get_run_outcomes', 'get_agent_activity', 'get_attachment', 'get_design', 'ask_question', 'propose_plan', 'approve_plan', 'flag_stale_docs', ...Object.keys(pmActionTools), ...Object.keys(pmDirectTools)]
    }
    if (!allowed[role]?.includes(tool)) throw new ToolError(`The ${role} can’t use ${tool}`)
    if (role === 'pm' && requiresPmConfirmation(tool, input)) {
      if (!this.#c.plans || !ctx.run.planSessionId) throw new ToolError('Planning is unavailable')
      return this.#c.pmActions.propose(ctx.run.planSessionId, ctx.run.id, tool, input, this.#c.runs.actor(ctx))
    }
    if (role === 'pm' && (isPmDirectTool(tool) || tool === 'act_on_inbox')) {
      if (!ctx.run.planSessionId) throw new ToolError('Planning is unavailable')
      return this.#c.pmTools.call(tool, input, this.#c.runs.actor(ctx), { sessionId: ctx.run.planSessionId, runId: ctx.run.id, projectId: ctx.project?.id ?? null })
    }
    if (tool === 'get_attachment' || tool === 'get_design') {
      const project = role === 'pm' && ctx.run.planSessionId && this.#c.plans
        ? await this.#c.plans.toolProject(ctx.run.planSessionId, input)
        : ctx.project
      if (!project) throw new ToolError('Provide a project slug in the project argument.')
      if (tool === 'get_attachment') return this.#getAttachment({ ...ctx, project }, z.object({ attachmentId: z.string() }).parse(input))
      const { taskRef: ref, version } = z.object({ taskRef: z.string(), version: z.number().int().positive().optional() }).parse(input)
      return readDesign(this.#c.d.db, this.#c.d.blobs, project, ref, version).catch((error: unknown) => {
        throw error instanceof DesignNotFound ? new ToolError(error.message) : error
      })
    }
    if (tool === 'attach_evidence') {
      const pmInput = role === 'pm' ? z.looseObject({ taskRef: z.string().optional(), project: z.string().optional() }).parse(input) : null
      const { taskRef: ref, ...fields } = pmInput ?? {}
      delete fields.project
      const parsed = evidenceSchema.safeParse(pmInput ? fields : input)
      if (!parsed.success) throw new ToolError(`Not attached. ${parsed.error.issues.map(i => i.message).join('. ')}.`)
      if (role === 'pm') {
        if (!this.#c.plans || !ctx.run.planSessionId) throw new ToolError('Planning is unavailable')
        if (ref) {
          const project = await this.#c.plans.toolProject(ctx.run.planSessionId, input)
          return this.#attachEvidence({ ...ctx, project, task: await findTaskByRef(this.#c.d.db, project, ref) }, parsed.data)
        }
        if (parsed.data.criterionId) throw new ToolError('Pass taskRef to attach evidence for a criterion')
        const attached = await this.#attachEvidence(ctx, parsed.data)
        const label = (parsed.data.kind === 'note' ? 'Evidence' : parsed.data.fileName).replace(/[[\]\\]/g, '')
        await this.#c.plans.attachEvidence(ctx.run.planSessionId, ctx.run.id, parsed.data.kind === 'note' ? parsed.data.note : `${parsed.data.note}\n\n[${label}](/api/evidence/${attached.id}/file)`)
        return attached
      }
      return this.#attachEvidence(ctx, parsed.data)
    }
    if (role === 'pm') {
      if (!this.#c.plans || !ctx.run.planSessionId) throw new ToolError('Planning is unavailable')
      if (tool === 'create_task' || tool === 'update_task' || tool === 'update_epic') return this.#c.pmCalls.editEntity(ctx, tool, input)
      return this.#c.plans.tool(ctx.run.planSessionId, ctx.run.id, tool, input, this.#c.runs.actor(ctx))
    }

    if (ctx.run.epicId) {
      if (tool === 'get_task') {
        const [epic] = await this.#c.d.db.select().from(schema.epics).where(eq(schema.epics.id, ctx.run.epicId))
        if (!epic) throw new ToolError('Epic no longer exists')
        return epicReviewContext(this.#c.d.db, epic, ctx.project!)
      }
      if (tool === 'get_evidence') return this.#getEvidence(ctx, z.object({ evidenceId: z.string().optional() }).parse(input))
      if (tool === 'report_outcome') {
        await this.#c.epicPrs.report(ctx.run, parseReport(epicReviewReportSchema, input))
        this.#c.ending.finished(ctx, 'Epic integration review recorded')
        return { ok: true }
      }
      throw new ToolError('Epic integration reviews use get_task, get_evidence and report_outcome')
    }
    switch (tool) {
      case 'get_task':
        return this.#getTask(ctx)
      case 'add_comment': {
        const { body } = z.object({ body: z.string().trim().min(1) }).parse(input)
        await this.#c.d.db.insert(comments).values({ taskId: ctx.task!.id, author: this.#c.runs.actor(ctx), body })
        return { ok: true }
      }
      case 'get_evidence':
        return this.#getEvidence(ctx, z.object({ evidenceId: z.string().optional() }).parse(input))
      case 'submit_design':
        return this.#c.outcomes.submitDesign(ctx, input)
      case 'report_outcome':
        // Human checks take no verdict, so a task with only those has none to give
        if (ctx.task && !ctx.task.rebaseOnly && await this.#onlyHumanChecks(ctx.task.id)) return this.#c.outcomes.reportOutcome(ctx, parseReport(outcomeReportSchema, { criteria: [], ...(input as object) }))
        return this.#c.outcomes.reportOutcome(ctx, ctx.task?.rebaseOnly ? parseReport(rebaseReviewReportSchema, input) : parseReport(outcomeReportSchema, input))
    }
    throw new ToolError(`Unknown tool ${tool}`)
  }

  async #getTask(ctx: RunContext) {
    const task = ctx.task!
    const criteria = await this.#c.d.db.select().from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, task.id)).orderBy(asc(acceptanceCriteria.position))
    const items = await listEvidence(this.#c.d.db, task.id)
    const notes = await this.#c.jobs.comments(task.id)
    return {
      ref: taskRef(ctx.project!.prefix, task.number),
      title: task.title,
      status: task.status,
      description: richTextToMarkdown(task.description),
      branch: task.branch,
      submissions: (await listTaskSubmissions(this.#c.d.db, task.id)).map(s => ({ sequence: s.sequence, headSha: s.submittedHeadSha, baseSha: s.baseSha, targetBranch: s.targetBranch, agentApprovedHeadSha: s.agentApprovedHeadSha, integratedCommitSha: s.integratedCommitSha, integratedAt: s.integratedAt?.toISOString() ?? null, createdAt: s.createdAt.toISOString() })),
      reviewRound: task.reviewRounds,
      criteria: criteria.map(c => ({ id: c.id, text: c.text, checkedByHuman: c.checkedByHuman })),
      comments: notes.map(c => ({ ...c, createdAt: c.createdAt.toISOString() })),
      attachments: await listTaskAttachments(this.#c.d.db, ctx.project!.id, task.description, notes),
      evidence: items.map(e => ({ id: e.id, criterionId: e.criterionId, kind: e.kind, note: e.note, fileName: e.fileName, round: e.round }))
    }
  }

  async #attachEvidence(ctx: RunContext, input: z.infer<typeof evidenceSchema>) {
    const task = ctx.task
    if (input.criterionId) {
      const [criterion] = await this.#c.d.db.select({ id: acceptanceCriteria.id }).from(acceptanceCriteria)
        .where(and(eq(acceptanceCriteria.id, input.criterionId), eq(acceptanceCriteria.taskId, task!.id)))
      if (!criterion) throw new ToolError(`${input.criterionId} isn't one of this task's acceptance criteria`)
    }
    const row = { taskId: task?.id ?? null, criterionId: input.criterionId, runId: ctx.run.id, round: task?.reviewRounds ?? 0, kind: input.kind }
    if (input.kind === 'note') {
      // A note: no blob, the text is the evidence
      const [note] = await this.#c.d.db.insert(evidence).values({ ...row, note: input.note.trim(), size: 0 }).returning()
      return { id: note!.id }
    }
    const data = Buffer.from(input.dataBase64, 'base64')
    if (data.length > MAX_EVIDENCE_BYTES) throw new ToolError('Evidence files are limited to 25 MB')
    const blob = await this.#c.d.blobs.put(data)
    const [file] = await this.#c.d.db.insert(evidence).values({
      ...row,
      note: input.note,
      blob,
      fileName: input.fileName,
      contentType: input.contentType,
      size: data.length
    }).returning()
    return { id: file!.id, sha256: blob }
  }

  // Evidence for the reviewer: a listing, or one item with its content.
  // Images come back as MCP image content so the reviewer can look at them.
  async #getEvidence(ctx: RunContext, input: { evidenceId?: string | undefined }) {
    const task = ctx.task
    const board = ctx.run.epicId ? await this.#c.d.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.epicId, ctx.run.epicId), isNull(tasks.deletedAt))) : []
    const items = task ? await listEvidence(this.#c.d.db, task.id) : (await Promise.all(board.map(t => listEvidence(this.#c.d.db, t.id)))).flat()
    if (!input.evidenceId) {
      return {
        round: task?.reviewRounds ?? 0,
        evidence: items.map(e => ({ id: e.id, criterionId: e.criterionId, kind: e.kind, note: e.note, fileName: e.fileName, contentType: e.contentType, size: e.size, round: e.round }))
      }
    }
    const item = items.find(e => e.id === input.evidenceId)
    if (!item) throw new ToolError(`${input.evidenceId} isn't evidence on this task`)
    const meta = { id: item.id, criterionId: item.criterionId, kind: item.kind, note: item.note, fileName: item.fileName, contentType: item.contentType, size: item.size }
    // A note is all text, already in the listing
    if (!item.contentType) return { ...meta, text: item.note }
    const [row] = await this.#c.d.db.select({ blob: evidence.blob }).from(evidence).where(eq(evidence.id, item.id))
    const data = row?.blob ? await this.#c.d.blobs.get(row.blob) : null
    if (!data) throw new ToolError('The file for this evidence is missing')
    if (IMAGE_TYPES.test(item.contentType)) {
      return { ...meta, images: [{ mimeType: item.contentType, dataBase64: Buffer.from(data).toString('base64') }] }
    }
    if (item.contentType.startsWith('text/') || item.contentType === 'application/json') {
      const text = new TextDecoder().decode(data.subarray(0, MAX_INLINE_TEXT))
      return { ...meta, text: data.length > MAX_INLINE_TEXT ? `${text}\n… (${data.length - MAX_INLINE_TEXT} more bytes)` : text }
    }
    return { ...meta, note: `${item.note} (binary ${item.contentType}; view it in Corral at ${this.#c.d.publicUrl}${item.url})`.trim() }
  }

  // An image as MCP content, scoped to the run's project for task agents
  // or to the explicitly resolved project for PM calls.
  async #getAttachment(ctx: RunContext, input: { attachmentId: string }) {
    const file = await readProjectAttachment(this.#c.d.db, this.#c.d.blobs, ctx.project!.id, input.attachmentId)
    if (!file) throw new ToolError(`${input.attachmentId} isn't an attachment in this project`)
    const { data, ...meta } = file
    return { ...meta, images: [{ mimeType: meta.mimeType, dataBase64: Buffer.from(data).toString('base64') }] }
  }

  async #onlyHumanChecks(taskId: string): Promise<boolean> {
    const rows = await this.#c.d.db.select({ checkedByHuman: acceptanceCriteria.checkedByHuman }).from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, taskId))
    return rows.length > 0 && rows.every(c => c.checkedByHuman)
  }
}
