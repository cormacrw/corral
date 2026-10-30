import { pmDirectTools, PM_RUN_LIST_MAX, type PmDirectTool, type Run, type RunEvent } from '@corral/contracts'
import type { Actor } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { appendAudit, auditEvent } from './audit.ts'
import { ApiFailure, fromDatabaseError } from './errors.ts'
import { findProjectBySlug } from './projects.ts'
import { findRun, listRuns } from './runs.ts'
import type { Transcripts } from './transcripts.ts'

const { projects, runs, tasks } = schema

const RUN_TEXT_MAX = 2_000
const LIST_TEXT_MAX = 300
const TOOL_INPUT_MAX = 200
const TOOL_OUTPUT_MAX = 500
const ERROR_SUMMARY_MAX = 300

// What each tool was trying to do, for the audit of a call that failed
const TOOL_GOALS: Record<PmDirectTool, string> = {
  list_runs: 'list runs',
  get_run: 'read a run'
}

interface Deps {
  db: Database
  transcripts: Transcripts
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
  summary: string
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

// The end of a transcript as text, never longer than the limit. It's empty
// when the agent produced nothing, even if the runner noted what it was doing.
export function transcriptExcerpt(events: RunEvent[], limit: number, ended: boolean) {
  const text = events.map(eventLine).filter(line => line !== null).join('\n\n')
  const truncated = text.length > limit
  const empty = !events.some(event => event.type === 'message' || event.type === 'tool_call' || event.type === 'tool_result')
  const notes = [
    ...(empty ? [ended ? 'This run has no agent transcript: the agent produced nothing before the run ended.' : 'This run has no agent transcript yet.'] : []),
    ...(truncated ? [`Transcript cut to its last ${limit} of ${text.length} characters.`] : [])
  ]
  return { excerpt: truncated ? text.slice(-limit) : text, truncated, empty, ...(notes.length > 0 && { note: notes.join(' ') }) }
}

// A failure in words the PM can act on; the API's codes alone say little
function toolFailure(error: unknown): Error {
  const failure = error instanceof ApiFailure ? error : fromDatabaseError(error)
  if (failure) return new Error(`Corral refused this: ${JSON.stringify(failure.body)}`)
  return error instanceof Error ? error : new Error(String(error))
}

// The PM's direct tools. Each validates its typed input and calls the service
// behind the matching route, and every call is audited with the PM run as
// actor. Runs are global like the agents that do them (D13), so these reads
// aren't limited to the conversation's project.
export class PmTools {
  #d: Deps
  constructor(deps: Deps) { this.#d = deps }

  async call(tool: PmDirectTool, input: unknown, actor: Actor, context: PmToolContext): Promise<unknown> {
    const audit = (projectId: string | undefined, outcome: { ok: boolean, summary: string, error?: string }) =>
      appendAudit(this.#d.db, { projectId: projectId ?? context.projectId, actor }, auditEvent('pm.tool_called', { sessionId: context.sessionId, runId: context.runId, tool, input, ...outcome }))
    try {
      const { result, projectId, summary } = await this.#run(tool, input)
      await audit(projectId, { ok: true, summary })
      return result
    } catch (error) {
      const failure = toolFailure(error)
      await audit(undefined, { ok: false, error: failure.message, summary: `Could not ${TOOL_GOALS[tool]}: ${clip(failure.message, ERROR_SUMMARY_MAX)}` })
      throw failure
    }
  }

  async #run(tool: PmDirectTool, input: unknown): Promise<ToolResult> {
    const { db, transcripts } = this.#d
    const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict().parse(input)
    switch (tool) {
      case 'list_runs': {
        const { project, taskRef, role, status, limit } = strict(pmDirectTools.list_runs.input)
        const projectId = project ? (await findProjectBySlug(db, project)).id : undefined
        const taskId = taskRef ? await this.#taskIdByRef(taskRef) : undefined
        const rows = await listRuns(db, {
          ...(projectId && { projectId }),
          ...(taskId && { taskId }),
          ...(role && { role }),
          ...(status === 'active' ? { active: true } : status ? { state: status } : {})
        }, limit + 1)
        const capped = rows.slice(0, limit).map(run => this.#capRun(run, LIST_TEXT_MAX))
        const notes = [
          ...(rows.length > limit ? [`Showing the newest ${limit} matching runs; there are more. ${limit < PM_RUN_LIST_MAX ? 'Raise limit or narrow' : 'Narrow'} the filters to see the rest.`] : []),
          ...(capped.some(c => c.capped) ? [`Summaries and errors are cut to ${LIST_TEXT_MAX} characters; get_run has more.`] : [])
        ]
        const filters = [project && `in ${project}`, taskRef && `on ${taskRef}`, role && `by ${role}s`, status && `with status ${status}`].filter(Boolean).join(' ')
        return {
          result: { runs: capped.map(c => c.run), ...(notes.length > 0 && { note: notes.join(' ') }) },
          ...(projectId && { projectId }),
          summary: `Listed ${capped.length} ${capped.length === 1 ? 'run' : 'runs'}${filters && ` ${filters}`}`
        }
      }

      case 'get_run': {
        const { runId, runNumber, transcriptLimit } = strict(pmDirectTools.get_run.input)
        if ((runId === undefined) === (runNumber === undefined)) throw new Error('Pass runNumber or runId, not both')
        const found = await findRun(db, runId === undefined ? eq(runs.number, runNumber!) : eq(runs.id, runId))
        if (!found) throw new Error(`Run ${runId ?? `#${runNumber}`} doesn't exist`)
        const [row] = await db.select({ blob: runs.transcriptBlob }).from(runs).where(eq(runs.id, found.id))
        const { run: shown, capped } = this.#capRun(found, RUN_TEXT_MAX)
        return {
          result: {
            ...shown,
            transcript: transcriptExcerpt(await transcripts.read(found.id, row?.blob ?? null), transcriptLimit, found.endedAt !== null),
            ...(capped && { note: `The summary and error are cut to ${RUN_TEXT_MAX} characters.` })
          },
          projectId: found.projectId,
          summary: `Read run #${found.number}${found.taskRef ? ` on ${found.taskRef}` : found.epicTitle ? ` on epic ${found.epicTitle}` : ''}`
        }
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
