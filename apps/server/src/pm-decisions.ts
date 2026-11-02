import { inboxActionInput, pmActionTools, type InboxActionInput, type Task } from '@corral/contracts'
import { taskRef, type Actor, type TaskStatus } from '@corral/core'
import { schema, type Database } from '@corral/db'
import { and, desc, eq, isNull } from 'drizzle-orm'
import { z } from 'zod'
import { idleStop } from './retry-recovery.ts'
import { humanApprovalSummary } from './pm-approval-summary.ts'
import type { PreparedPmAction } from './pm-actions.ts'

const { designVersions, projects, tasks } = schema

class ToolError extends Error {}

type PmInboxAction = Exclude<InboxActionInput, { action: 'decide' }>

type DecisionTool = 'act_on_inbox' | 'approve_design' | 'request_design_changes'

// Only what's waiting on the human can be decided from the Inbox
const INBOX_ACTION_STATUSES: Record<Exclude<PmInboxAction['action'], 'clarify'>, readonly TaskStatus[]> = {
  approve: ['human_review'],
  request_changes: ['human_review'],
  resolve: ['blocked', 'failed'],
  send_back: ['blocked', 'failed'],
  retry: [],
  delete: ['human_review', 'blocked', 'failed']
}

// A task stopped from repeating (COR-436) waits in the Inbox in its own status
const STOPPED_TASK_ACTIONS: readonly string[] = ['resolve', 'send_back', 'retry', 'delete']

interface Deps {
  db: Database
  inboxAction(taskId: string, input: InboxActionInput, actor: Actor): Promise<Task | null>
  approveDesign(taskId: string, version: number, note: string | undefined, actor: Actor): Promise<void>
}

// The PM's confirm-required Inbox and design tools (D30), prepared and executed
// through PmActions. Each takes a task by ref from any project, as the Inbox
// it reads spans them.
export class PmDecisions {
  #d: Deps
  constructor(deps: Deps) { this.#d = deps }

  async prepare(tool: DecisionTool, input: unknown): Promise<PreparedPmAction> {
    const parsed = z.object(pmActionTools[tool].input as z.ZodRawShape).strict().parse(input) as { taskRef: string, version: number, feedback?: string, note?: string }
    const { task, project, ref } = await this.#task(parsed.taskRef)
    const prepared = { input: { ...parsed, taskRef: ref }, targetId: task.id, taskId: task.id, projectId: project.id }
    if (tool === 'act_on_inbox') {
      const action = parseInboxAction(parsed)
      if (action.action === 'clarify') throw new ToolError('clarify acts directly and has no confirmation')
      if (!INBOX_ACTION_STATUSES[action.action].includes(task.status) && !(idleStop(task) && STOPPED_TASK_ACTIONS.includes(action.action))) throw new ToolError(`${ref} is ${task.status}, so ${action.action} doesn't apply. list_inbox shows what's waiting.`)
      if (action.action === 'approve' && task.type === 'design') throw new ToolError('Use approve_design to approve a design')
      return { ...prepared, summary: inboxSummary(action, ref, task) + (action.action === 'approve' ? await humanApprovalSummary(this.#d.db, task.id) : '') }
    }
    const { version, feedback, note } = parsed
    if (task.type !== 'design') throw new ToolError(`${ref} is not a design task`)
    if (task.status !== 'human_review') throw new ToolError(`${ref} is ${task.status}, not waiting on a design decision`)
    const [row] = await this.#d.db.select({ status: designVersions.status }).from(designVersions).where(and(eq(designVersions.taskId, task.id), eq(designVersions.version, version)))
    if (!row) throw new ToolError(`${ref} has no version ${version}`)
    // Approved already is a retry: its build's message may never have gone out
    if (row.status !== 'submitted' && !(tool === 'approve_design' && row.status === 'approved')) throw new ToolError(`Version ${version} of ${ref} is ${row.status}`)
    // inboxAction sends feedback to the latest submitted version. Check this
    // both when proposing and when Confirm re-prepares the saved action.
    if (tool === 'request_design_changes') {
      const [latest] = await this.#d.db.select({ version: designVersions.version }).from(designVersions)
        .where(and(eq(designVersions.taskId, task.id), eq(designVersions.status, 'submitted'))).orderBy(desc(designVersions.version)).limit(1)
      if (latest?.version !== version) throw new ToolError(`Version ${version} of ${ref} is no longer the latest submitted version; request changes on v${latest?.version} instead`)
    }
    // The note goes to the build's Plan session as the human's words, so they see it first
    return { ...prepared, summary: tool === 'approve_design' ? `Approve v${version} of ${ref}: ${task.title}${note ? `. Note: ${note}` : ''}${await humanApprovalSummary(this.#d.db, task.id)}` : `Request changes on v${version} of ${ref} (${task.title}): ${feedback}` }
  }

  async execute(tool: DecisionTool, prepared: PreparedPmAction, actor: Actor): Promise<string> {
    const { taskId, input } = prepared
    if (!taskId) throw new ToolError(`Unknown confirm-required tool ${tool}`)
    const ref = String(input.taskRef)
    switch (tool) {
      case 'act_on_inbox': {
        const task = await this.#d.inboxAction(taskId, parseInboxAction(input), actor)
        return task ? `${ref} is now ${task.status}.` : `Deleted ${ref}.`
      }
      case 'approve_design':
        await this.#d.approveDesign(taskId, input.version as number, input.note as string | undefined, actor)
        return `Approved v${String(input.version)} of ${ref}.`
      case 'request_design_changes': {
        await this.#d.inboxAction(taskId, { action: 'request_changes', text: input.feedback as string }, actor)
        return `Sent v${String(input.version)} of ${ref} back with the feedback.`
      }
    }
  }

  async #task(ref: string) {
    const match = /^([A-Za-z]+)-(\d+)$/.exec(ref)
    if (!match) throw new ToolError(`${ref} is not a task ref; refs look like COR-12`)
    const [row] = await this.#d.db.select({ task: tasks, project: projects }).from(tasks).innerJoin(projects, eq(projects.id, tasks.projectId))
      .where(and(eq(projects.prefix, match[1]!.toUpperCase()), eq(tasks.number, Number(match[2])), isNull(tasks.deletedAt)))
    if (!row) throw new ToolError(`Task ${ref} no longer exists`)
    return { ...row, ref: taskRef(row.project.prefix, row.task.number) }
  }
}

// Ignores the tool's taskRef, which the route has in its path
function parseInboxAction(input: unknown): PmInboxAction {
  const parsed = inboxActionInput.safeParse(input)
  if (!parsed.success) throw new ToolError(`Not done: ${z.prettifyError(parsed.error)}`)
  if (parsed.data.action === 'decide') throw new ToolError('Rebase decisions must be answered by the human in the Inbox')
  return parsed.data
}

// Resolving is what lifts a cap: the card says so (D10)
export function resetNote(task: Pick<typeof tasks.$inferSelect, 'status' | 'failedRuns' | 'reviewRounds'>): string {
  if (task.status === 'failed') return `. This resets its failed run count from ${task.failedRuns} to 0, so it gets a full set of runs again`
  if (task.status === 'blocked') return `. This resets its review round count from ${task.reviewRounds} to 0, so it gets a full set of rounds again`
  return ''
}

function inboxSummary(input: Exclude<PmInboxAction, { action: 'clarify' }>, ref: string, task: typeof tasks.$inferSelect): string {
  switch (input.action) {
    case 'approve': return `Approve and merge ${ref}: ${task.title}${task.prNumber ? ` (PR #${task.prNumber} at ${task.headSha ?? 'its head'})` : ''}${input.text ? `. Note: ${input.text}` : ''}`
    case 'request_changes': return `Request changes on ${ref} (${task.title}): ${input.text}`
    case 'resolve': return `${idleStop(task) && input.to !== 'backlog' ? `Release the stop on ${ref}, which carries on in ${task.status.replace('_', ' ')}` : `Move ${ref} to ${input.to.replace('_', ' ')}`}: ${task.title}${input.text ? `. Note: ${input.text}` : ''}${resetNote(task)}`
    case 'send_back': return `Send ${ref} back to the Backlog: ${task.title}`
    case 'retry': return `Retry ${ref}: ${task.title}${input.text ? `. Note: ${input.text}` : ''}`
    case 'delete': return `Delete ${ref}: ${task.title}${input.text ? `. Reason: ${input.text}` : ''}`
  }
}
