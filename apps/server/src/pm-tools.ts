import { pmDirectTools, PM_PROJECT_LIST_MAX, PM_RUN_LIST_MAX, type PmDirectTool, type RunEvent, type Run } from '@corral/contracts'
import type { Actor } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { ApiFailure, fromDatabaseError } from './errors.ts'
import type { EventBus } from './events.ts'
import type { Orchestrator } from './orchestrator.ts'
import { createProject, findProjectBySlug, listProjects, patchProject, toProject } from './projects.ts'
import type { RunnerHub } from './runner-hub.ts'
import { getRun, listRuns } from './runs.ts'
import { checkRepository } from './setup.ts'
import type { Transcripts } from './transcripts.ts'

const { auditLog, projects, tasks } = schema

// A tool call fails after two minutes on the runner (TOOL_CALL_TIMEOUT_MS), so
// the check gives up first: a project is never created behind a timed-out call
const CHECK_REPO_TIMEOUT_MS = 100_000
const RUN_TEXT_MAX = 2_000
const LIST_TEXT_MAX = 300
const TOOL_INPUT_MAX = 200
const TOOL_OUTPUT_MAX = 500

interface Deps {
  db: Database
  events: EventBus
  runner: RunnerHub
  transcripts: Transcripts
  orchestrator: Pick<Orchestrator, 'status' | 'holdForUpdate' | 'releaseUpdate' | 'messageRun' | 'poke'>
}

export interface PmToolContext {
  sessionId: string
  runId: string
  // The conversation's project, for the audit of calls with no project of their own
  projectId: string
}

interface ToolResult {
  result: unknown
  projectId?: string
  // Set when the call changed something: what shows in Activity
  changed?: string
}

function capText(text: string | null, max: number): { text: string | null, capped: boolean } {
  return text !== null && text.length > max ? { text: `${text.slice(0, max)}…`, capped: true } : { text, capped: false }
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}…` : text
}

function eventLine(event: RunEvent): string | null {
  switch (event.type) {
    case 'system': return `[system] ${event.text}`
    case 'message': return event.text
    case 'tool_call': return `[tool] ${event.tool} ${clip(JSON.stringify(event.input) ?? '', TOOL_INPUT_MAX)}`
    case 'tool_result': return `[${event.isError ? 'tool error' : 'tool result'}] ${clip(event.output, TOOL_OUTPUT_MAX)}`
    case 'thinking':
    case 'usage': return null
  }
}

// The end of a transcript as text, never longer than the limit
export function transcriptExcerpt(events: RunEvent[], limit: number) {
  const text = events.map(eventLine).filter(line => line !== null).join('\n\n')
  if (text.length <= limit) return { excerpt: text, truncated: false }
  return { excerpt: text.slice(-limit), truncated: true, note: `Transcript cut to its last ${limit} of ${text.length} characters.` }
}

// A failure in words the PM can act on; the API's codes alone say little
function toolFailure(error: unknown): Error {
  const failure = error instanceof ApiFailure ? error : fromDatabaseError(error)
  if (failure) return new Error(`Corral refused this: ${JSON.stringify(failure.body)}`)
  return error instanceof Error ? error : new Error(String(error))
}

// The PM tools that act without a confirm card (D27). Each validates its typed
// input and calls the service behind the matching route, and every call is
// audited with the PM session as actor.
export class PmTools {
  #d: Deps
  constructor(deps: Deps) { this.#d = deps }

  async call(tool: PmDirectTool, input: unknown, actor: Actor, context: PmToolContext): Promise<unknown> {
    const audit = (projectId: string | undefined, outcome: Record<string, unknown>) => this.#d.db.insert(auditLog).values({
      projectId: projectId ?? context.projectId,
      actor,
      action: 'pm.tool_called',
      detail: { sessionId: context.sessionId, runId: context.runId, tool, input, ...outcome }
    })
    try {
      const { result, projectId, changed } = await this.#run(tool, input, actor)
      await audit(projectId, changed ? { ok: true, changed: true, summary: changed } : { ok: true })
      return result
    } catch (error) {
      const failure = toolFailure(error)
      await audit(undefined, { ok: false, error: failure.message })
      throw failure
    }
  }

  async #run(tool: PmDirectTool, input: unknown, actor: Actor): Promise<ToolResult> {
    const { db, events, orchestrator, runner } = this.#d
    const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict().parse(input)
    switch (tool) {
      case 'list_projects': {
        strict(pmDirectTools.list_projects.input)
        const all = await listProjects(db)
        return {
          result: {
            projects: all.slice(0, PM_PROJECT_LIST_MAX),
            ...(all.length > PM_PROJECT_LIST_MAX && { note: `Showing the first ${PM_PROJECT_LIST_MAX} of ${all.length} projects.` })
          }
        }
      }

      case 'get_project': {
        const { project } = strict(pmDirectTools.get_project.input)
        return { result: toProject(await findProjectBySlug(db, project)) }
      }

      case 'update_project': {
        const { project: slug, ...changes } = strict(pmDirectTools.update_project.input)
        const fields = Object.entries(changes).filter(([, value]) => value !== undefined)
        if (fields.length === 0) throw new Error('Nothing to change: pass at least one setting')
        const project = await findProjectBySlug(db, slug)
        const updated = await patchProject(db, project, changes, actor)
        events.publish({ type: 'project.updated', project: updated })
        orchestrator.poke()
        const list = fields.map(([key, value]) => `${key} to ${JSON.stringify(value)}`).join(', ')
        return { result: updated, projectId: project.id, changed: `Set ${list} on ${updated.name}` }
      }

      case 'create_project': {
        const { defaultBranch, ...parsed } = strict(pmDirectTools.create_project.input)
        const check = await checkRepository(db, runner, parsed.repository, CHECK_REPO_TIMEOUT_MS)
        if (!check.ready) throw new Error(`The project was not created: ${check.checks.filter(c => !c.ok).map(c => `${c.title}: ${c.detail}`).join(' ')}`)
        const branch = defaultBranch ?? check.defaultBranch
        if (!branch) throw new Error('The project was not created: the repository has no default branch; pass defaultBranch')
        const project = await createProject(db, { ...parsed, defaultBranch: branch }, actor)
        events.publish({ type: 'project.created', project })
        return { result: project, projectId: project.id, changed: `Created project ${project.name} for ${project.repository}` }
      }

      case 'list_runs': {
        const { project, taskRef, status, limit } = strict(pmDirectTools.list_runs.input)
        const projectId = project ? (await findProjectBySlug(db, project)).id : undefined
        const taskId = taskRef ? await this.#taskIdByRef(taskRef) : undefined
        const rows = await listRuns(db, {
          ...(projectId && { projectId }),
          ...(taskId && { taskId }),
          ...(status === 'active' ? { active: true } : status ? { state: status } : {})
        }, limit + 1)
        const capped = rows.slice(0, limit).map(run => this.#capRun(run, LIST_TEXT_MAX))
        const notes = [
          ...(rows.length > limit ? [`Showing the newest ${limit} matching runs; there are more. ${limit < PM_RUN_LIST_MAX ? 'Raise limit or narrow' : 'Narrow'} the filters to see the rest.`] : []),
          ...(capped.some(c => c.capped) ? [`Summaries and errors are cut to ${LIST_TEXT_MAX} characters; get_run has more.`] : [])
        ]
        return { result: { runs: capped.map(c => c.run), ...(notes.length > 0 && { note: notes.join(' ') }) } }
      }

      case 'get_run': {
        const { runId, transcriptLimit } = strict(pmDirectTools.get_run.input)
        const run = await getRun(db, runId)
        const [row] = await db.select({ blob: schema.runs.transcriptBlob }).from(schema.runs).where(eq(schema.runs.id, runId))
        const { run: shown, capped } = this.#capRun(run, RUN_TEXT_MAX)
        return {
          result: {
            ...shown,
            transcript: transcriptExcerpt(await this.#d.transcripts.read(runId, row?.blob ?? null), transcriptLimit),
            ...(capped && { note: `The summary and error are cut to ${RUN_TEXT_MAX} characters.` })
          }
        }
      }

      case 'message_run': {
        const { runId, text } = strict(pmDirectTools.message_run.input)
        const run = await getRun(db, runId)
        const sent = await orchestrator.messageRun(run.projectId, runId, { text: `From the PM: ${text}`, attachments: [] }, actor)
        return { result: { ok: true, runId: sent.runId, commentId: sent.comment.id }, projectId: run.projectId, changed: `Messaged run #${run.number}${run.taskRef ? ` on ${run.taskRef}` : ''}: ${clip(text, LIST_TEXT_MAX)}` }
      }

      case 'get_status':
        strict(pmDirectTools.get_status.input)
        return { result: { ...orchestrator.status, ...runner.status() } }

      case 'set_update_hold': {
        strict(pmDirectTools.set_update_hold.input)
        const held = orchestrator.status.updating
        const busy = await orchestrator.holdForUpdate()
        return { result: { ...orchestrator.status, busy }, ...(!held && { changed: 'Held Corral for an update' }) }
      }

      case 'clear_update_hold': {
        strict(pmDirectTools.clear_update_hold.input)
        const held = orchestrator.status.updating
        orchestrator.releaseUpdate()
        return { result: orchestrator.status, ...(held && { changed: 'Lifted the update hold' }) }
      }
    }
  }

  #capRun(run: Run, max: number): { run: Run, capped: boolean } {
    const summary = capText(run.summary, max)
    const error = capText(run.error, max)
    return { run: { ...run, summary: summary.text, error: error.text }, capped: summary.capped || error.capped }
  }

  async #taskIdByRef(ref: string): Promise<string> {
    const match = /^([A-Za-z]+)-(\d+)$/.exec(ref)
    if (!match) throw new Error(`${ref} isn't a task ref; they look like COR-12`)
    const [row] = await this.#d.db.select({ id: tasks.id }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(eq(projects.prefix, match[1]!.toUpperCase()), eq(tasks.number, Number(match[2])), isNull(tasks.deletedAt)))
    if (!row) throw new Error(`Task ${ref} doesn't exist`)
    return row.id
  }
}
