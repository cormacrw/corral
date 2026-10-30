import { createAgentInput, pmActionTools, pmDirectTools, PM_PROJECT_LIST_MAX, PM_RUN_LIST_MAX, type InboxItem, type PmDirectTool, type RunEvent, type Run } from '@corral/contracts'
import { taskRef, type Actor } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { appendAudit, auditEvent } from './audit.ts'
import { ApiFailure, fromDatabaseError } from './errors.ts'
import type { EventBus } from './events.ts'
import { loadInbox } from './inbox.ts'
import type { Orchestrator } from './orchestrator.ts'
import { createProject, findProjectBySlug, listProjects, patchProject, toProject } from './projects.ts'
import type { RunnerHub } from './runner-hub.ts'
import { createAgent, findRun, getRun, listAgents, listRuns, patchAgent } from './runs.ts'
import { checkRepository, requireRuntimeCli } from './setup.ts'
import { addComment, applyTransition, lockTask } from './tasks.ts'
import type { Transcripts } from './transcripts.ts'

const { projects, runs, tasks } = schema

// A tool call fails after two minutes on the runner (TOOL_CALL_TIMEOUT_MS), so
// the check gives up first: a project is never created behind a timed-out call
const CHECK_REPO_TIMEOUT_MS = 100_000
const RUN_TEXT_MAX = 2_000
const LIST_TEXT_MAX = 300
const TOOL_INPUT_MAX = 200
const TOOL_OUTPUT_MAX = 500
const ERROR_SUMMARY_MAX = 300

// act_on_inbox is direct only for clarify; its other actions take a confirm card
type PmToolName = PmDirectTool | 'act_on_inbox'

// What each tool was trying to do, for the Activity line of a call that failed
const TOOL_GOALS: Record<PmToolName, string> = {
  start_thread: 'start a thread',
  list_threads: 'list threads',
  read_thread: 'read a thread',
  message_thread: 'message a thread',
  close_thread: 'close a thread',
  list_projects: 'list projects',
  get_project: 'read a project',
  update_project: 'change a project',
  create_project: 'create a project',
  list_runs: 'list runs',
  get_run: 'read a run',
  message_run: 'message a run',
  get_status: 'check Corral\'s status',
  set_update_hold: 'hold Corral for an update',
  clear_update_hold: 'lift the update hold',
  list_inbox: 'read the Inbox',
  list_agents: 'list agents',
  update_agent: 'change an agent',
  create_agent: 'create an agent',
  act_on_inbox: 'answer an Inbox item'
}

interface Deps {
  db: Database
  events: EventBus
  runner: RunnerHub
  transcripts: Transcripts
  orchestrator: Pick<Orchestrator, 'status' | 'holdForUpdate' | 'releaseUpdate' | 'messageRun' | 'poke' | 'taskChanged' | 'plans'>
}

export interface PmToolContext {
  sessionId: string
  runId: string
  // The conversation's project, for the audit of calls with no project of their own.
  // A global conversation has none.
  projectId: string | null
}

interface ToolResult {
  result: unknown
  projectId?: string | null
  // The task it acted on, so Activity can link to it
  target?: { taskId: string, taskRef: string }
  // What the call did, in the words Activity shows
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
export function transcriptExcerpt(events: RunEvent[], limit: number, ended = false) {
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

// The same failure in plain words, for the Activity line
function failureReason(error: unknown): string {
  const failure = error instanceof ApiFailure ? error : fromDatabaseError(error)
  if (!failure) return error instanceof Error ? error.message : String(error)
  const { code, reason, constraint } = failure.body as { code: string, reason?: unknown, constraint?: unknown }
  return typeof reason === 'string' ? reason : typeof constraint === 'string' ? `${code.replaceAll('_', ' ')}: ${constraint}` : code.replaceAll('_', ' ')
}

// The PM tools that act without a confirm card (D27). Each validates its typed
// input and calls the service behind the matching route, and every call is
// audited with the PM session as actor.
export class PmTools {
  #d: Deps
  constructor(deps: Deps) { this.#d = deps }

  async call(tool: PmToolName, input: unknown, actor: Actor, context: PmToolContext): Promise<unknown> {
    const audit = (projectId: string | null | undefined, outcome: { ok: boolean, summary: string, error?: string }, target?: ToolResult['target']) =>
      appendAudit(this.#d.db, { projectId: projectId === undefined ? context.projectId : projectId, taskId: target?.taskId, actor }, auditEvent('pm.tool_called', { sessionId: context.sessionId, runId: context.runId, tool, input: target ? { ...input as object, taskRef: target.taskRef } : input, targetId: target?.taskId ?? null, ...outcome }))
    try {
      const { result, projectId, target, summary } = await this.#run(tool, input, actor, context)
      await audit(projectId, { ok: true, summary }, target)
      return result
    } catch (error) {
      const failure = toolFailure(error)
      await audit(undefined, { ok: false, error: failure.message, summary: `Could not ${TOOL_GOALS[tool]}: ${clip(failureReason(error), ERROR_SUMMARY_MAX)}` })
      throw failure
    }
  }

  async #run(tool: PmToolName, input: unknown, actor: Actor, context: PmToolContext): Promise<ToolResult> {
    const { db, events, orchestrator, runner, transcripts } = this.#d
    const strict = <T extends z.ZodRawShape>(shape: T) => z.object(shape).strict().parse(input)
    switch (tool) {
      case 'start_thread': {
        const { title, project, message, runtime } = strict(pmDirectTools.start_thread.input)
        if (!orchestrator.plans) throw new Error('Planning is unavailable')
        const projectId = project ? (await findProjectBySlug(db, project)).id : null
        const result = await orchestrator.plans.start(projectId, { text: message, title, parentSessionId: context.sessionId, ...(runtime && { runtime }) }, actor)
        return { result, projectId: result.projectId, summary: `Started thread ${title}` }
      }
      case 'list_threads': {
        strict(pmDirectTools.list_threads.input)
        if (!orchestrator.plans) throw new Error('Planning is unavailable')
        const sessions = await orchestrator.plans.listSessions()
        const allProjects = await listProjects(db)
        return { result: sessions.map(s => ({ ...s, project: allProjects.find(p => p.id === s.projectId)?.slug ?? null, running: s.activeRunId !== null })), summary: `Listed ${sessions.length} threads` }
      }
      case 'read_thread': {
        const { threadId, limit } = strict(pmDirectTools.read_thread.input)
        if (!orchestrator.plans) throw new Error('Planning is unavailable')
        const { messages, ...session } = await orchestrator.plans.getSession(threadId)
        return { result: { ...session, messages: messages.slice(-limit).reverse() }, projectId: session.projectId, summary: `Read thread ${session.title}` }
      }
      case 'message_thread': {
        const { threadId, message } = strict(pmDirectTools.message_thread.input)
        if (!orchestrator.plans) throw new Error('Planning is unavailable')
        const target = await orchestrator.plans.getSession(threadId)
        const result = await orchestrator.plans.message(threadId, { text: message, senderSessionId: context.sessionId }, actor)
        return { result, projectId: target.projectId, summary: `Messaged thread ${threadId}` }
      }
      case 'close_thread': {
        const { threadId } = strict(pmDirectTools.close_thread.input)
        if (!orchestrator.plans) throw new Error('Planning is unavailable')
        const result = await orchestrator.plans.close(threadId, actor)
        return { result, projectId: result.projectId, summary: `Closed thread ${result.title}` }
      }
      case 'list_projects': {
        strict(pmDirectTools.list_projects.input)
        const all = await listProjects(db)
        return {
          result: {
            projects: all.slice(0, PM_PROJECT_LIST_MAX),
            ...(all.length > PM_PROJECT_LIST_MAX && { note: `Showing the first ${PM_PROJECT_LIST_MAX} of ${all.length} projects.` })
          },
          summary: `Listed ${all.length} ${all.length === 1 ? 'project' : 'projects'}`
        }
      }

      case 'get_project': {
        const { project } = strict(pmDirectTools.get_project.input)
        const row = await findProjectBySlug(db, project)
        return { result: toProject(row), projectId: row.id, summary: `Read project ${row.name}` }
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
        return { result: updated, projectId: project.id, summary: `Set ${list} on ${updated.name}` }
      }

      case 'create_project': {
        const { defaultBranch, ...parsed } = strict(pmDirectTools.create_project.input)
        const check = await checkRepository(db, runner, parsed.repository, CHECK_REPO_TIMEOUT_MS)
        if (!check.ready) throw new Error(`The project was not created: ${check.checks.filter(c => !c.ok).map(c => `${c.title}: ${c.detail}`).join(' ')}`)
        const branch = defaultBranch ?? check.defaultBranch
        if (!branch) throw new Error('The project was not created: the repository has no default branch; pass defaultBranch')
        const project = await createProject(db, { ...parsed, defaultBranch: branch }, actor)
        events.publish({ type: 'project.created', project })
        return { result: project, projectId: project.id, summary: `Created project ${project.name} for ${project.repository}` }
      }

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
          ...(found.projectId && { projectId: found.projectId }),
          summary: `Read run #${found.number}${found.taskRef ? ` on ${found.taskRef}` : found.epicTitle ? ` on epic ${found.epicTitle}` : ''}`
        }
      }
      case 'message_run': {
        const { runId, text } = strict(pmDirectTools.message_run.input)
        const run = await getRun(db, runId)
        if (!run.projectId) throw new Error(`Run #${run.number} is a ${run.role} run; only developer and reviewer runs take messages`)
        const sent = await orchestrator.messageRun(run.projectId, runId, { text: `From the PM: ${text}`, attachments: [] }, actor)
        return { result: { ok: true, runId: sent.runId, commentId: sent.comment.id }, projectId: run.projectId, summary: `Messaged run #${run.number}${run.taskRef ? ` on ${run.taskRef}` : ''}: ${clip(text, LIST_TEXT_MAX)}` }
      }

      case 'get_status':
        strict(pmDirectTools.get_status.input)
        return { result: { ...orchestrator.status, ...runner.status() }, summary: 'Checked Corral\'s status' }

      case 'set_update_hold': {
        strict(pmDirectTools.set_update_hold.input)
        const held = orchestrator.status.updating
        const busy = await orchestrator.holdForUpdate()
        return { result: { ...orchestrator.status, busy }, summary: held ? 'Checked the update hold, which was already on' : 'Held Corral for an update' }
      }

      case 'clear_update_hold': {
        strict(pmDirectTools.clear_update_hold.input)
        const held = orchestrator.status.updating
        orchestrator.releaseUpdate()
        return { result: orchestrator.status, summary: held ? 'Lifted the update hold' : 'Tried to lift the update hold, which was already off' }
      }

      case 'list_inbox': {
        strict(pmDirectTools.list_inbox.input)
        const items = (await loadInbox(db)).needsYou
        return { result: items.map(toolItem), summary: `Read the Inbox: ${items.length} ${items.length === 1 ? 'item' : 'items'}` }
      }

      case 'list_agents': {
        strict(pmDirectTools.list_agents.input)
        const agents = await listAgents(db)
        return { result: agents, summary: `Listed ${agents.length} ${agents.length === 1 ? 'agent' : 'agents'}` }
      }

      case 'update_agent': {
        const { agentId, ...changes } = strict(pmDirectTools.update_agent.input)
        const fields = Object.entries(changes).filter(([, value]) => value !== undefined)
        if (fields.length === 0) throw new Error('Nothing to change: pass at least one setting')
        if (changes.runtime) await requireRuntimeCli(runner, changes.runtime)
        const agent = await patchAgent(db, agentId, changes, actor)
        events.publish({ type: 'agent.updated', agent })
        orchestrator.poke()
        return { result: agent, summary: `Updated ${agent.name}: ${fields.map(([key, value]) => `${key} ${String(value)}`).join(', ')}` }
      }

      case 'create_agent': {
        const parsed = createAgentInput.strict().parse(input)
        await requireRuntimeCli(runner, parsed.runtime)
        const agent = await createAgent(db, parsed, actor)
        events.publish({ type: 'agent.updated', agent })
        orchestrator.poke()
        return { result: agent, summary: `Created ${agent.name}: ${parsed.role} on ${parsed.runtime}` }
      }

      case 'act_on_inbox':
        return this.#answer(input, actor)
    }
  }

  // A Blocked task's question, answered for the human: the same pinned
  // comment as Clarify, by the PM's own transition (D27)
  async #answer(input: unknown, actor: Actor): Promise<ToolResult> {
    const { taskRef: ref, action, text } = z.object(pmActionTools.act_on_inbox.input).strict().parse(input)
    if (action !== 'clarify' || !text) throw new Error('clarify needs text: your answer for the developer')
    const { db, events, orchestrator } = this.#d
    const taskId = await this.#taskIdByRef(ref)
    const { comment, project, number } = await db.transaction(async (tx) => {
      const { task, project } = await lockTask(tx, taskId)
      const added = await addComment(tx, task.id, { body: text, pinned: true }, actor)
      await applyTransition(tx, task, project, { type: 'answer' }, actor)
      return { comment: added, project, number: task.number }
    })
    events.publish({ type: 'comment.created', comment })
    await orchestrator.taskChanged(taskId)
    const answered = taskRef(project.prefix, number)
    return { result: { ref: answered, status: 'in_progress' }, projectId: project.id, target: { taskId, taskRef: answered }, summary: `Answered ${answered}: ${clip(text, LIST_TEXT_MAX)}` }
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

// What the PM needs of an Inbox item: enough to tell the human and to act on it
function toolItem(item: InboxItem) {
  const common = { id: item.id, type: item.type, project: item.project?.slug ?? null, taskRef: item.taskRef, subject: item.subject, from: item.sender.name, at: item.at, prUrl: item.prUrl }
  switch (item.type) {
    case 'plan_thread': return { ...common, sessionId: item.sessionId, status: item.status, asking: item.question?.text ?? item.plan?.title ?? item.reply ?? item.preview }
    case 'release_notes': return { ...common, unread: item.unread, asking: item.preview }
    case 'epic_review': return { ...common, epicId: item.epicId, asking: item.body }
    default: return { ...common, asking: item.body || item.preview }
  }
}
