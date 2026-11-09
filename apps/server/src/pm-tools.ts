import { askQuestionInput, isGatedTool, isPmTool, isProjectScopedTool, listTasksInput, parsePmToolInput, PM_TOOL_NAMES, proposedPlanInput, toolDefinitions, type PmTool, type PmToolInput, type ProjectScopedPmTool, type ToolDefinition } from '@corral/contracts'
import { clip, parseTaskRef, type Actor } from '@corral/core'
import { schema, type Database, type PlanSessionRow, type ProjectRow } from '@corral/db'
import { eq } from 'drizzle-orm'
import { z } from 'zod'
import { readEvidenceInput } from './agent-files.ts'
import { appendAudit, auditEvent } from './audit.ts'
import { ApiFailure, failureReason, fromDatabaseError } from './errors.ts'
import { taskAndProjectByRef } from './task-rows.ts'
import { ToolError } from './tool-error.ts'

// The PM's tools (D30): one handler per tool, with its schema, confirm and
// gate policy and project scoping from its definition in contracts. Every PM
// call goes through here, from the runner and from a confirmed card.

const { planSessions, projects } = schema

const ERROR_SUMMARY_MAX = 300

// What a confirm card proposes, bound to its target: a confirmation can't
// move to another one
export interface PreparedPmAction {
  input: Record<string, unknown>
  summary: string
  targetId: string | null
  taskId: string | null
  projectId: string | null
}

// The input as the server reads it, where it takes more than the PM is
// offered: older runners' names, and a file's contents in place of its path
const READERS = {
  list_tasks: (input: unknown) => refused(listTasksInput.extend({ project: z.string().optional() }), input, error => `The tasks were not listed: ${z.prettifyError(error)}`),
  ask_question: (input: unknown) => refused(askQuestionInput, input, error => `The question was not asked: ${z.prettifyError(error)}`),
  propose_plan: (input: unknown) => refused(proposedPlanInput.extend({ project: z.string().optional() }), input, error => `The plan was not saved: ${z.prettifyError(error)}`),
  attach_evidence: readEvidenceInput
}

// A scoped tool's `project`, read ahead of the rest so a global session
// asks for it first
const scopedProject = z.object({ project: z.string().trim().min(1).optional() })

function refused<T extends z.ZodType>(schema: T, input: unknown, message: (error: z.ZodError) => string): z.output<T> {
  const parsed = schema.safeParse(input)
  if (!parsed.success) throw new ToolError(message(parsed.error))
  return parsed.data
}

type ReadInput<T extends PmTool> = T extends keyof typeof READERS ? ReturnType<typeof READERS[T]> : PmToolInput<T>
// The project a scoped tool names is resolved into the call's `project`
type PmToolCallInput<T extends PmTool> = T extends ProjectScopedPmTool ? Omit<ReadInput<T>, 'project'> : ReadInput<T>

export interface PmToolCall<T extends PmTool> {
  sessionId: string
  runId: string
  session: PlanSessionRow
  input: PmToolCallInput<T>
  // A project-scoped tool acts in its `project` input or the conversation's
  project: T extends ProjectScopedPmTool ? ProjectRow : null
  actor: Actor
}

interface PmToolResult {
  result: unknown
  // What the call did, in the words Activity shows. Audited tools only.
  summary?: string
  projectId?: string | null
  // The task it acted on, so Activity can link to it
  target?: { taskId: string, taskRef: string }
}

interface PmToolHandler<T extends PmTool> {
  // Each call that acts straight away is audited (pm.tool_called) and shows
  // in Activity; this is what it was trying to do, for a failed one
  goal?: string
  run?(call: PmToolCall<T>): Promise<PmToolResult>
  // A confirm card: what it proposes, and what Confirm does
  prepare?(call: PmToolCall<T>): Promise<PreparedPmAction>
  execute?(call: PmToolCall<T>, prepared: PreparedPmAction): Promise<unknown>
  // A gated tool: the card for what this call lowers, or null when it lowers
  // nothing. The card keeps the call's input as the PM sent it.
  lowers?(call: PmToolCall<T>): Promise<Omit<PreparedPmAction, 'input'> | null>
}

export type PmToolHandlers = { [T in PmTool]: PmToolHandler<T> }

interface PmToolsDeps {
  db: Database
  handlers: PmToolHandlers
  // Posts the card; nothing changes until the human confirms
  propose(sessionId: string, runId: string, tool: PmTool, prepared: PreparedPmAction, actor: Actor): Promise<unknown>
}

// A task in any project by its ref, for the tools that span projects
export async function taskByAnyRef(db: Database, ref: string) {
  if (!parseTaskRef(ref)) throw new ToolError(`${ref} isn't a task ref; refs look like COR-12`)
  const found = await taskAndProjectByRef(db, ref)
  if (!found) throw new ToolError(`Task ${ref} doesn't exist`)
  return found
}

// A failure in words the PM can act on; the API's codes alone say little
function toolFailure(error: unknown): Error {
  const failure = error instanceof ApiFailure ? error : fromDatabaseError(error)
  if (failure) return new Error(`Corral refused this: ${JSON.stringify(failure.body)}`)
  return error instanceof Error ? error : new Error(String(error))
}

// How much of a free-text field a PM listing or card summary shows
export const LIST_TEXT_MAX = 300

function confirmPolicy(tool: PmTool): NonNullable<ToolDefinition['confirmRequired']> {
  return (toolDefinitions[tool] as ToolDefinition).confirmRequired ?? false
}

function confirms(tool: PmTool, input: unknown): boolean {
  const policy = confirmPolicy(tool)
  return typeof policy === 'function' ? policy(input) : policy
}

export class PmTools {
  #d: PmToolsDeps

  constructor(deps: PmToolsDeps) {
    for (const tool of PM_TOOL_NAMES) {
      const handler: PmToolHandler<PmTool> = deps.handlers[tool]
      const policy = confirmPolicy(tool)
      if (policy !== false && !(handler.prepare && handler.execute)) throw new Error(`${tool} takes a confirm card but has none`)
      if (policy !== true && !handler.run) throw new Error(`${tool} acts directly but has no handler`)
      if (isGatedTool(tool) && !(handler.lowers && handler.execute)) throw new Error(`${tool} is gated but can't tell what it lowers`)
    }
    this.#d = deps
  }

  // A call from the PM's run. A confirm-required call, or a gated one that
  // lowers a gate, becomes a card; anything else acts now.
  async call(sessionId: string, runId: string, tool: PmTool, raw: unknown, actor: Actor): Promise<unknown> {
    const handler: PmToolHandler<PmTool> = this.#d.handlers[tool]
    if (confirms(tool, raw)) {
      const call = await this.#read(sessionId, runId, tool, raw, actor)
      return this.#d.propose(sessionId, runId, tool, await handler.prepare!(call), actor)
    }
    const failed = async (error: unknown) => {
      if (!handler.goal) return error
      const failure = toolFailure(error)
      await this.#audit(sessionId, runId, tool, raw, actor, { ok: false, error: failure.message, summary: `Could not ${handler.goal}: ${clip(failureReason(error), ERROR_SUMMARY_MAX)}` })
      return failure
    }
    let call: PmToolCall<PmTool>
    let lowered: PreparedPmAction | null
    try {
      call = await this.#read(sessionId, runId, tool, raw, actor)
      lowered = await this.#lowers(handler, call, raw)
    } catch (error) {
      throw await failed(error)
    }
    if (lowered) return this.#d.propose(sessionId, runId, tool, lowered, actor)
    try {
      const { result, ...done } = await handler.run!(call)
      if (handler.goal) await this.#audit(sessionId, runId, tool, raw, actor, { ok: true, summary: done.summary ?? '' }, done)
      return result
    } catch (error) {
      throw await failed(error)
    }
  }

  // A card's action as it stands now, for the human's Confirm to compare
  // with what the card says
  async prepare(sessionId: string, runId: string, tool: string, raw: unknown): Promise<PreparedPmAction> {
    if (!isPmTool(tool)) throw new ToolError('This tool is no longer available for confirmation')
    const handler: PmToolHandler<PmTool> = this.#d.handlers[tool]
    const call = await this.#read(sessionId, runId, tool, raw, { kind: 'agent', role: 'pm', runId })
    if (confirms(tool, raw)) return handler.prepare!(call)
    if (!handler.lowers) throw new ToolError('This tool is no longer available for confirmation')
    const lowered = await this.#lowers(handler, call, raw)
    if (!lowered) throw new ToolError('The target of this action has changed')
    return lowered
  }

  async execute(sessionId: string, runId: string, tool: string, prepared: PreparedPmAction, actor: Actor): Promise<unknown> {
    if (!isPmTool(tool)) throw new ToolError('This tool is no longer available for confirmation')
    const handler: PmToolHandler<PmTool> = this.#d.handlers[tool]
    return handler.execute!(await this.#read(sessionId, runId, tool, prepared.input, actor), prepared)
  }

  async #lowers(handler: PmToolHandler<PmTool>, call: PmToolCall<PmTool>, raw: unknown): Promise<PreparedPmAction | null> {
    const lowered = handler.lowers ? await handler.lowers(call) : null
    return lowered && { ...lowered, input: raw as Record<string, unknown> }
  }

  async #read(sessionId: string, runId: string, tool: PmTool, raw: unknown, actor: Actor): Promise<PmToolCall<PmTool>> {
    const [session] = await this.#d.db.select().from(planSessions).where(eq(planSessions.id, sessionId))
    if (!session) throw new ToolError('The conversation no longer exists')
    const read = (READERS as Partial<Record<PmTool, (input: unknown) => unknown>>)[tool] ?? (input => parsePmToolInput(tool, input))
    if (!isProjectScopedTool(tool)) return { sessionId, runId, session, input: read(raw), project: null, actor } as PmToolCall<PmTool>
    const project = await this.#project(session, scopedProject.parse(raw ?? {}).project)
    // The project is resolved, so the handler doesn't see the slug
    const input = Object.fromEntries(Object.entries(read(raw) as object).filter(([key]) => key !== 'project'))
    return { sessionId, runId, session, input, project, actor } as PmToolCall<PmTool>
  }

  async #project(session: PlanSessionRow, slug: string | undefined): Promise<ProjectRow> {
    if (!slug && !session.projectId) throw new ToolError('Provide a project slug in the project argument for this global session.')
    const [project] = await this.#d.db.select().from(projects).where(slug ? eq(projects.slug, slug) : eq(projects.id, session.projectId!))
    if (!project) throw new ToolError(slug ? `Unknown project: ${slug}` : 'The project no longer exists')
    return project
  }

  async #audit(sessionId: string, runId: string, tool: PmTool, raw: unknown, actor: Actor, outcome: { ok: boolean, summary: string, error?: string }, done: Omit<PmToolResult, 'result'> = {}): Promise<void> {
    const [session] = await this.#d.db.select({ projectId: planSessions.projectId }).from(planSessions).where(eq(planSessions.id, sessionId))
    const { target } = done
    await appendAudit(this.#d.db, { projectId: done.projectId === undefined ? session?.projectId ?? null : done.projectId, taskId: target?.taskId ?? null, actor },
      auditEvent('pm.tool_called', { sessionId, runId, tool, input: target ? { ...raw as object, taskRef: target.taskRef } : raw, targetId: target?.taskId ?? null, ...outcome }))
  }
}
