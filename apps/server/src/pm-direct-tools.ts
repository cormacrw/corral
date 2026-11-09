import { PM_PROJECT_LIST_MAX, PM_RUN_LIST_MAX, storedProjectFields, TOOL_CALL_TIMEOUT_MS, toolName, type ActionableInboxItem, type Run, type RunEvent } from '@corral/contracts'
import { clip } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { eq } from 'drizzle-orm'
import type { Commands } from './commands.ts'
import type { Controls } from './controls.ts'
import type { HumanActions } from './human-actions.ts'
import { loadInbox } from './inbox.ts'
import type { PlanService } from './plan.ts'
import { LIST_TEXT_MAX, taskByAnyRef, type PmToolHandlers } from './pm-tools.ts'
import { findProjectBySlug, listProjects, toProject } from './projects.ts'
import type { RunnerHub } from './runner-hub.ts'
import { findRun, getRun, listAgents, listRuns, readRunTranscript } from './runs.ts'
import { checkRepository } from './setup.ts'
import type { Transcripts } from './transcripts.ts'

// The PM's tools that act as soon as it calls them (D30): each calls the
// service behind the matching route, and every call is audited with the PM
// session as actor.

const { runs } = schema

// The check gives up before the runner's tool call does: a project is never
// created behind a timed-out call
const CHECK_REPO_TIMEOUT_MS = TOOL_CALL_TIMEOUT_MS - 20_000
const RUN_TEXT_MAX = 2_000
const TOOL_INPUT_MAX = 200
const TOOL_OUTPUT_MAX = 500

interface PmDirectToolsDeps {
  db: Database
  runner: RunnerHub
  transcripts: Transcripts
  controls: Pick<Controls, 'status' | 'releaseUpdate'>
  human: Pick<HumanActions, 'messageRun'>
  plans: Pick<PlanService, 'start' | 'listSessions' | 'getSession' | 'message' | 'close'>
  commands: Pick<Commands, 'createProject' | 'createAgent' | 'patchAgent'>
}

function capText(text: string | null, max: number): { text: string | null, capped: boolean } {
  return text !== null && text.length > max ? { text: clip(text, max), capped: true } : { text, capped: false }
}

function capRun(run: Run, max: number): { run: Run, capped: boolean } {
  const summary = capText(run.summary, max)
  const error = capText(run.error, max)
  return { run: { ...run, summary: summary.text, error: error.text }, capped: summary.capped || error.capped }
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

const plural = (count: number, one: string, many: string) => `${count} ${count === 1 ? one : many}`

type DirectTool = 'start_thread' | 'list_threads' | 'read_thread' | 'message_thread' | 'close_thread' | 'list_projects' | 'get_project' | 'create_project'
  | 'list_runs' | 'get_run' | 'message_run' | 'get_status' | 'clear_update_hold' | 'list_inbox' | 'list_agents' | 'update_agent' | 'create_agent'

export function pmDirectTools(deps: PmDirectToolsDeps): Pick<PmToolHandlers, DirectTool> {
  const { db, runner, transcripts, controls, human, plans, commands } = deps
  return {
    start_thread: {
      goal: 'start a thread',
      async run({ input: { title, project, message, runtime }, sessionId, actor }) {
        const projectId = project ? (await findProjectBySlug(db, project)).id : null
        const result = await plans.start(projectId, { text: message, title, parentSessionId: sessionId, ...(runtime && { runtime }) }, actor)
        return { result, projectId: result.projectId, summary: `Started thread ${title}` }
      }
    },
    list_threads: {
      goal: 'list threads',
      async run() {
        const sessions = await plans.listSessions()
        const allProjects = await listProjects(db)
        return { result: sessions.map(s => ({ ...s, project: allProjects.find(p => p.id === s.projectId)?.slug ?? null, running: s.activeRunId !== null })), summary: `Listed ${sessions.length} threads` }
      }
    },
    read_thread: {
      goal: 'read a thread',
      async run({ input: { threadId, limit } }) {
        const { messages, ...session } = await plans.getSession(threadId)
        return { result: { ...session, messages: messages.slice(-limit).reverse() }, projectId: session.projectId, summary: `Read thread ${session.title}` }
      }
    },
    message_thread: {
      goal: 'message a thread',
      async run({ input: { threadId, message }, sessionId, actor }) {
        const target = await plans.getSession(threadId)
        const result = await plans.message(threadId, { text: message, senderSessionId: sessionId }, actor)
        return { result, projectId: target.projectId, summary: `Messaged thread ${threadId}` }
      }
    },
    close_thread: {
      goal: 'close a thread',
      async run({ input: { threadId }, actor }) {
        const result = await plans.close(threadId, actor)
        return { result, projectId: result.projectId, summary: `Closed thread ${result.title}` }
      }
    },
    list_projects: {
      goal: 'list projects',
      async run() {
        const all = await listProjects(db)
        return {
          result: {
            projects: all.slice(0, PM_PROJECT_LIST_MAX),
            ...(all.length > PM_PROJECT_LIST_MAX && { note: `Showing the first ${PM_PROJECT_LIST_MAX} of ${all.length} projects.` })
          },
          summary: `Listed ${plural(all.length, 'project', 'projects')}`
        }
      }
    },
    get_project: {
      goal: 'read a project',
      async run({ input: { project } }) {
        const row = await findProjectBySlug(db, project)
        return { result: toProject(row), projectId: row.id, summary: `Read project ${row.name}` }
      }
    },
    create_project: {
      goal: 'create a project',
      async run({ input: { defaultBranch, ...neutral }, actor }) {
        const parsed = storedProjectFields(neutral)
        const check = await checkRepository(db, runner, parsed.repository, CHECK_REPO_TIMEOUT_MS)
        if (!check.ready) throw new Error(`The project was not created: ${check.checks.filter(c => !c.ok).map(c => `${c.title}: ${c.detail}`).join(' ')}`)
        const branch = defaultBranch ?? check.defaultBranch
        if (!branch) throw new Error('The project was not created: the repository has no default branch; pass defaultBranch')
        const project = await commands.createProject({ ...parsed, defaultBranch: branch }, actor)
        return { result: project, projectId: project.id, summary: `Created project ${project.name} for ${project.repository}` }
      }
    },
    list_runs: {
      goal: 'list runs',
      async run({ input: { project, taskRef, role, status, limit } }) {
        const projectId = project ? (await findProjectBySlug(db, project)).id : undefined
        const taskId = taskRef ? (await taskByAnyRef(db, taskRef)).task.id : undefined
        const rows = await listRuns(db, {
          ...(projectId && { projectId }),
          ...(taskId && { taskId }),
          ...(role && { role }),
          ...(status === 'active' ? { active: true } : status ? { state: status } : {})
        }, limit + 1)
        const capped = rows.slice(0, limit).map(run => capRun(run, LIST_TEXT_MAX))
        const notes = [
          ...(rows.length > limit ? [`Showing the newest ${limit} matching runs; there are more. ${limit < PM_RUN_LIST_MAX ? 'Raise limit or narrow' : 'Narrow'} the filters to see the rest.`] : []),
          ...(capped.some(c => c.capped) ? [`Summaries and errors are cut to ${LIST_TEXT_MAX} characters; ${toolName('get_run')} has more.`] : [])
        ]
        const filters = [project && `in ${project}`, taskRef && `on ${taskRef}`, role && `by ${role}s`, status && `with status ${status}`].filter(Boolean).join(' ')
        return {
          result: { runs: capped.map(c => c.run), ...(notes.length > 0 && { note: notes.join(' ') }) },
          ...(projectId && { projectId }),
          summary: `Listed ${plural(capped.length, 'run', 'runs')}${filters && ` ${filters}`}`
        }
      }
    },
    get_run: {
      goal: 'read a run',
      async run({ input: { runId, runNumber, transcriptLimit } }) {
        if ((runId === undefined) === (runNumber === undefined)) throw new Error('Pass runNumber or runId, not both')
        const found = await findRun(db, runId === undefined ? eq(runs.number, runNumber!) : eq(runs.id, runId))
        if (!found) throw new Error(`Run ${runId ?? `#${runNumber}`} doesn't exist`)
        const { run: shown, capped } = capRun(found, RUN_TEXT_MAX)
        return {
          result: {
            ...shown,
            transcript: transcriptExcerpt(await readRunTranscript(db, transcripts, found.id), transcriptLimit, found.endedAt !== null),
            ...(capped && { note: `The summary and error are cut to ${RUN_TEXT_MAX} characters.` })
          },
          ...(found.projectId && { projectId: found.projectId }),
          summary: `Read run #${found.number}${found.taskRef ? ` on ${found.taskRef}` : found.epicTitle ? ` on ${found.epicTitle}` : ''}`
        }
      }
    },
    message_run: {
      goal: 'message a run',
      async run({ input: { runId, text }, actor }) {
        const run = await getRun(db, runId)
        const sent = await human.messageRun(run.projectId, runId, { text: `From the PM: ${text}`, attachments: [] }, actor)
        return { result: { ok: true, runId: sent.runId, commentId: sent.comment.id }, projectId: run.projectId, summary: `Messaged run #${run.number}${run.taskRef ? ` on ${run.taskRef}` : ''}: ${clip(text, LIST_TEXT_MAX)}` }
      }
    },
    get_status: {
      goal: 'check Corral\'s status',
      async run() {
        return { result: { ...controls.status, ...runner.status() }, summary: 'Checked Corral\'s status' }
      }
    },
    clear_update_hold: {
      goal: 'lift the update hold',
      async run() {
        const held = controls.status.updating
        controls.releaseUpdate()
        return { result: controls.status, summary: held ? 'Lifted the update hold' : 'Tried to lift the update hold, which was already off' }
      }
    },
    list_inbox: {
      goal: 'read the Inbox',
      async run() {
        const items = (await loadInbox(db, runner)).needsYou
        return { result: items.map(toolItem), summary: `Read the Inbox: ${plural(items.length, 'item', 'items')}` }
      }
    },
    list_agents: {
      goal: 'list agents',
      async run() {
        const agents = await listAgents(db)
        return { result: agents, summary: `Listed ${plural(agents.length, 'agent', 'agents')}` }
      }
    },
    update_agent: {
      goal: 'change an agent',
      async run({ input: { agentId, ...changes }, actor }) {
        const fields = Object.entries(changes).filter(([, value]) => value !== undefined)
        if (fields.length === 0) throw new Error('Nothing to change: pass at least one setting')
        const agent = await commands.patchAgent(agentId, changes, actor)
        return { result: agent, summary: `Updated ${agent.name}: ${fields.map(([key, value]) => `${key} ${String(value)}`).join(', ')}` }
      }
    },
    create_agent: {
      goal: 'create an agent',
      async run({ input, actor }) {
        const agent = await commands.createAgent(input, actor)
        return { result: agent, summary: `Created ${agent.name}: ${input.role} on ${input.runtime}` }
      }
    }
  }
}

// What the PM needs of an Inbox item: enough to tell the human and to act on it
function toolItem(item: ActionableInboxItem) {
  const common = { id: item.id, type: item.type, project: item.project?.slug ?? null, taskRef: item.taskRef, subject: item.subject, from: item.sender.name, at: item.at, prUrl: item.prUrl }
  switch (item.type) {
    case 'plan_thread': return { ...common, sessionId: item.sessionId, status: item.status, asking: item.question?.text ?? item.plan?.title ?? item.failure ?? item.preview }
    case 'epic_review': return { ...common, epicId: item.epicId, asking: item.body }
    default: return { ...common, asking: item.body || item.preview }
  }
}
