import { epicReviewReportSchema, IMAGE_CONTENT_TYPES, outcomeReportSchema, rebaseReviewReportSchema, toolDefinitions, toolName, toolRefusal, toolsForJob, type PmTool, type RunnerMessage } from '@corral/contracts'
import { taskRef, richTextToMarkdown } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { attachEvidence, getAttachment, getDesign, parseEvidence } from './agent-files.ts'
import { listTaskAttachments } from './attachments.ts'
import { ApiFailure } from './errors.ts'
import { listEvidence } from './runs.ts'
import { listTaskSubmissions } from './task-submissions.ts'
import { epicResolutionBranch } from './task-base.ts'
import type { BlobStore } from './blob-store.ts'
import type { EpicFixes } from './epic-fix-runs.ts'
import type { EpicReviewRuns } from './epic-review-runs.ts'
import type { PmTools } from './pm-tools.ts'
import { runActor, type RunContext, type RunContexts } from './run-context.ts'
import type { RunEnding } from './run-ending.ts'
import type { RunJobs } from './run-jobs.ts'
import type { RunOutcomes } from './run-outcomes.ts'
import { ToolError } from './tool-error.ts'
import { epicReviewContext } from './epic-review.ts'
import { addCommentWithTransition } from './comments.ts'
import { taskCriteria } from './criteria.ts'

const { acceptanceCriteria, evidence, tasks } = schema

// A report that doesn't fit its schema comes back to the agent field by field
function parseReport<T>(schema: z.ZodType<T>, input: unknown): T {
  const parsed = schema.safeParse(input)
  if (parsed.success) return parsed.data
  const fields = parsed.error.issues.map(i => `${i.path.join('.')}: ${i.message}`)
  throw new ToolError(`Not reported. ${fields.join('. ')}. Fix this and report again.`)
}

// Text evidence is returned inline up to this size
const MAX_INLINE_TEXT = 64 * 1024

interface AgentToolsDeps {
  db: Database
  blobs: BlobStore
  // Where people open Corral, for links to evidence
  publicUrl: string
  runs: Pick<RunContexts, 'fenced'>
  ending: Pick<RunEnding, 'finished'>
  jobs: Pick<RunJobs, 'comments'>
  outcomes: Pick<RunOutcomes, 'reportOutcome' | 'submitDesign'>
  fixes: Pick<EpicFixes, 'report'>
  epicReviews: Pick<EpicReviewRuns, 'report'>
  pmTools: Pick<PmTools, 'call'>
}

export class AgentTools {
  #d: AgentToolsDeps

  constructor(deps: AgentToolsDeps) {
    this.#d = deps
  }

  async onToolCall(message: Extract<RunnerMessage, { type: 'tool.call' }>, runnerId: string): Promise<unknown> {
    const ctx = await this.#d.runs.fenced(message.runId, message.leaseEpoch)
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
    if (!(toolsForJob(ctx.run) as readonly string[]).includes(tool)) throw new ToolError(toolRefusal(role, tool))
    if (role === 'pm') return this.#d.pmTools.call(ctx.run.planSessionId!, ctx.run.id, tool as PmTool, input, runActor(ctx))
    const { db, blobs } = this.#d
    if (tool === 'get_attachment') return getAttachment(db, blobs, ctx.project!.id, z.object(toolDefinitions.get_attachment.input).parse(input).attachmentId)
    if (tool === 'get_design') {
      const { taskRef: ref, version } = z.object(toolDefinitions.get_design.input).parse(input)
      return getDesign(db, blobs, ctx.project!, ref, version)
    }
    if (tool === 'attach_evidence') return attachEvidence(db, blobs, { runId: ctx.run.id, task: ctx.task }, parseEvidence(input))

    if (ctx.kind === 'epic_fix' || ctx.kind === 'epic_review') {
      if (tool === 'get_task') {
        const [epic] = await this.#d.db.select().from(schema.epics).where(eq(schema.epics.id, ctx.run.epicId!))
        if (!epic) throw new ToolError('Task no longer exists')
        const context = await epicReviewContext(this.#d.db, epic, ctx.project!)
        return ctx.kind === 'epic_fix' ? { ...context, fix: ctx.run.fixKind, branch: epicResolutionBranch(ctx.run.operationId!) } : context
      }
      if (tool === 'get_evidence') return this.#getEvidence(ctx, z.object(toolDefinitions.get_evidence.input).parse(input))
      if (tool === 'report_outcome' && ctx.kind === 'epic_fix') return this.#d.fixes.report(ctx, parseReport(outcomeReportSchema, { criteria: [], ...(input as object) }))
      if (tool === 'report_outcome') {
        await this.#d.epicReviews.report(ctx.run, parseReport(epicReviewReportSchema, input))
        this.#d.ending.finished(ctx, 'Task integration review recorded')
        return { ok: true }
      }
      throw new ToolError(`Runs on a task with subtasks use ${toolName('get_task')} and ${toolName('report_outcome')}, and an integration review ${toolName('get_evidence')} too`)
    }
    switch (tool) {
      case 'get_task':
        return this.#getTask(ctx)
      case 'add_comment': {
        const { body } = z.object({ body: z.string().trim().min(1) }).parse(input)
        await addCommentWithTransition(this.#d.db, ctx.task!.id, { body }, runActor(ctx))
        return { ok: true }
      }
      case 'get_evidence':
        return this.#getEvidence(ctx, z.object(toolDefinitions.get_evidence.input).parse(input))
      case 'submit_design':
        return this.#d.outcomes.submitDesign(ctx, input)
      case 'report_outcome':
        // Human checks take no verdict, so a task with only those has none to give
        if (ctx.task && !ctx.task.rebaseOnly && await this.#onlyHumanChecks(ctx.task.id)) return this.#d.outcomes.reportOutcome(ctx, parseReport(outcomeReportSchema, { criteria: [], ...(input as object) }))
        return this.#d.outcomes.reportOutcome(ctx, ctx.task?.rebaseOnly ? parseReport(rebaseReviewReportSchema, input) : parseReport(outcomeReportSchema, input))
    }
    throw new ToolError(`Unknown tool ${tool}`)
  }

  async #getTask(ctx: RunContext) {
    const task = ctx.task!
    const criteria = await taskCriteria(this.#d.db, task.id)
    const items = await listEvidence(this.#d.db, task.id)
    const notes = await this.#d.jobs.comments(task.id)
    return {
      ref: taskRef(ctx.project!.prefix, task.number),
      kind: task.kind,
      title: task.title,
      status: task.status,
      description: richTextToMarkdown(task.description),
      implementationPlan: richTextToMarkdown(task.implementationPlan),
      branch: task.branch,
      submissions: (await listTaskSubmissions(this.#d.db, task.id)).map(s => ({ sequence: s.sequence, headSha: s.submittedHeadSha, baseSha: s.baseSha, targetBranch: s.targetBranch, agentApprovedHeadSha: s.agentApprovedHeadSha, integratedCommitSha: s.integratedCommitSha, integratedAt: s.integratedAt?.toISOString() ?? null, createdAt: s.createdAt.toISOString() })),
      reviewRound: task.reviewRounds,
      criteria: criteria.map(c => ({ id: c.id, text: c.text, checkedByHuman: c.checkedByHuman })),
      comments: notes.map(c => ({ ...c, createdAt: c.createdAt.toISOString() })),
      attachments: await listTaskAttachments(this.#d.db, ctx.project!.id, task, notes),
      evidence: items.map(e => ({ id: e.id, criterionId: e.criterionId, kind: e.kind, note: e.note, fileName: e.fileName, round: e.round }))
    }
  }

  // Evidence for the reviewer: a listing, or one item with its content.
  // Images come back as MCP image content so the reviewer can look at them.
  async #getEvidence(ctx: RunContext, input: { evidenceId?: string | undefined }) {
    const task = ctx.task
    const board = ctx.run.epicId ? await this.#d.db.select({ id: tasks.id }).from(tasks).where(and(eq(tasks.epicId, ctx.run.epicId), isNull(tasks.deletedAt))) : []
    const items = task ? await listEvidence(this.#d.db, task.id) : (await Promise.all(board.map(t => listEvidence(this.#d.db, t.id)))).flat()
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
    const [row] = await this.#d.db.select({ blob: evidence.blob }).from(evidence).where(eq(evidence.id, item.id))
    const data = row?.blob ? await this.#d.blobs.get(row.blob) : null
    if (!data) throw new ToolError('The file for this evidence is missing')
    if ((IMAGE_CONTENT_TYPES as readonly string[]).includes(item.contentType)) {
      return { ...meta, images: [{ mimeType: item.contentType, dataBase64: Buffer.from(data).toString('base64') }] }
    }
    if (item.contentType.startsWith('text/') || item.contentType === 'application/json') {
      const text = new TextDecoder().decode(data.subarray(0, MAX_INLINE_TEXT))
      return { ...meta, text: data.length > MAX_INLINE_TEXT ? `${text}\n… (${data.length - MAX_INLINE_TEXT} more bytes)` : text }
    }
    return { ...meta, note: `${item.note} (binary ${item.contentType}; view it in Corral at ${this.#d.publicUrl}${item.url})`.trim() }
  }

  async #onlyHumanChecks(taskId: string): Promise<boolean> {
    const rows = await this.#d.db.select({ checkedByHuman: acceptanceCriteria.checkedByHuman }).from(acceptanceCriteria).where(eq(acceptanceCriteria.taskId, taskId))
    return rows.length > 0 && rows.every(c => c.checkedByHuman)
  }
}
