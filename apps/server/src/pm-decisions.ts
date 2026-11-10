import { inboxActionInput, toolName, type InboxActionInput } from '@corral/contracts'
import { clip, inboxActionApplies, statusWords, taskRef } from '@corral/core'
import { schema, type Database, type TaskRow } from '@corral/db'
import { and, desc, eq } from 'drizzle-orm'
import { z } from 'zod'
import type { HumanActions } from './human-actions.ts'
import { humanApprovalSummary } from './pm-approval-summary.ts'
import { LIST_TEXT_MAX, taskByAnyRef, type PmToolHandlers, type PreparedPmAction } from './pm-tools.ts'
import { idleStop } from './retry-recovery.ts'
import { ToolError } from './tool-error.ts'

// The PM's Inbox and design tools (D30). Each takes a task by ref from any
// project, as the Inbox it reads spans them. Only a developer's question is
// answered straight away; every decision takes a confirm card.

const { designVersions } = schema

interface PmDecisionsDeps {
  db: Database
  human: Pick<HumanActions, 'inboxAction' | 'approveDesign' | 'clarify'>
}

// Ignores the tool's taskRef, which the route has in its path
function parseInboxAction(input: unknown): InboxActionInput {
  const parsed = inboxActionInput.safeParse(input)
  if (!parsed.success) throw new ToolError(`Not done: ${z.prettifyError(parsed.error)}`)
  return parsed.data
}

// Resolving is what lifts a cap: the card says so (D10)
export function resetNote(task: Pick<TaskRow, 'status' | 'failedRuns' | 'reviewRounds'>): string {
  if (task.status === 'failed') return `. This resets its failed run count from ${task.failedRuns} to 0, so it gets a full set of runs again`
  if (task.status === 'blocked') return `. This resets its review round count from ${task.reviewRounds} to 0, so it gets a full set of rounds again`
  return ''
}

function inboxSummary(input: Exclude<InboxActionInput, { action: 'clarify' }>, ref: string, task: TaskRow): string {
  switch (input.action) {
    case 'approve': return `Approve and merge ${ref}: ${task.title}${task.prNumber ? ` (PR #${task.prNumber} at ${task.headSha ?? 'its head'})` : ''}${input.text ? `. Note: ${input.text}` : ''}`
    case 'request_changes': return `Request changes on ${ref} (${task.title}): ${input.text}`
    case 'resolve': return `${idleStop(task) && input.to !== 'backlog' ? `Release the stop on ${ref}, which carries on in ${statusWords(task.status)}` : `Move ${ref} to ${statusWords(input.to)}`}: ${task.title}${input.text ? `. Note: ${input.text}` : ''}${resetNote(task)}`
    case 'send_back': return `Send ${ref} back to the Backlog: ${task.title}`
    case 'retry': return `Retry ${ref}: ${task.title}${input.text ? `. Note: ${input.text}` : ''}`
    case 'delete': return `Delete ${ref}: ${task.title}${input.text ? `. Reason: ${input.text}` : ''}`
  }
}

export function pmDecisions(deps: PmDecisionsDeps): Pick<PmToolHandlers, 'act_on_inbox' | 'approve_design' | 'request_design_changes'> {
  const { db, human } = deps

  const target = async (ref: string) => {
    const { task, project } = await taskByAnyRef(db, ref)
    return { task, project, ref: taskRef(project.prefix, task.number) }
  }
  const bound = (task: TaskRow, projectId: string) => ({ targetId: task.id, taskId: task.id, projectId })

  const designCard = async (tool: 'approve_design' | 'request_design_changes', input: { taskRef: string, version: number }) => {
    const { task, project, ref } = await target(input.taskRef)
    const { version } = input
    if (task.type !== 'design') throw new ToolError(`${ref} is not a design task`)
    if (task.status !== 'human_review') throw new ToolError(`${ref} is ${task.status}, not waiting on a design decision`)
    const [row] = await db.select({ status: designVersions.status }).from(designVersions).where(and(eq(designVersions.taskId, task.id), eq(designVersions.version, version)))
    if (!row) throw new ToolError(`${ref} has no version ${version}`)
    // Approved already is a retry: its build's message may never have gone out
    if (row.status !== 'submitted' && !(tool === 'approve_design' && row.status === 'approved')) throw new ToolError(`Version ${version} of ${ref} is ${row.status}`)
    return { task, project, ref }
  }

  return {
    act_on_inbox: {
      goal: 'answer an Inbox item',
      // A Blocked task's question, answered for the human: the same pinned
      // comment as Clarify, by the PM's own transition (D30)
      async run({ input: { taskRef: ref, action, text }, actor }) {
        if (action !== 'clarify' || !text) throw new Error('clarify needs text: your answer for the developer')
        const { task, project, ref: answered } = await target(ref)
        await human.clarify(task.id, text, actor)
        return { result: { ref: answered, status: 'in_progress' }, projectId: project.id, target: { taskId: task.id, taskRef: answered }, summary: `Answered ${answered}: ${clip(text, LIST_TEXT_MAX)}` }
      },
      async prepare({ input }) {
        const { task, project, ref } = await target(input.taskRef)
        const action = parseInboxAction(input)
        if (action.action === 'clarify') throw new ToolError('clarify acts directly and has no confirmation')
        if (!inboxActionApplies(action.action, { status: task.status, stopped: idleStop(task) })) throw new ToolError(`${ref} is ${task.status}, so ${action.action} doesn't apply. ${toolName('list_inbox')} shows what's waiting.`)
        if (action.action === 'approve' && task.type === 'design') throw new ToolError(`Use ${toolName('approve_design')} to approve a design`)
        return { input: { ...input, taskRef: ref }, ...bound(task, project.id), summary: inboxSummary(action, ref, task) + (action.action === 'approve' ? await humanApprovalSummary(db, task.id) : '') }
      },
      async execute({ input, actor }, prepared: PreparedPmAction) {
        const task = await human.inboxAction(prepared.taskId!, parseInboxAction(input), actor)
        return task ? `${input.taskRef} is now ${task.status}.` : `Deleted ${input.taskRef}.`
      }
    },
    approve_design: {
      async prepare({ input }) {
        const { task, project, ref } = await designCard('approve_design', input)
        const { version, note } = input
        // The note goes to the build's Plan session as the human's words, so they see it first
        return { input: { ...input, taskRef: ref }, ...bound(task, project.id), summary: `Approve v${version} of ${ref}: ${task.title}${note ? `. Note: ${note}` : ''}${await humanApprovalSummary(db, task.id)}` }
      },
      async execute({ input, actor }, prepared) {
        await human.approveDesign(prepared.taskId!, input.version, input.note, actor)
        return `Approved v${input.version} of ${input.taskRef}.`
      }
    },
    request_design_changes: {
      async prepare({ input }) {
        const { task, project, ref } = await designCard('request_design_changes', input)
        const { version, feedback } = input
        // inboxAction sends feedback to the latest submitted version. Check this
        // both when proposing and when Confirm re-prepares the saved action.
        const [latest] = await db.select({ version: designVersions.version }).from(designVersions)
          .where(and(eq(designVersions.taskId, task.id), eq(designVersions.status, 'submitted'))).orderBy(desc(designVersions.version)).limit(1)
        if (latest?.version !== version) throw new ToolError(`Version ${version} of ${ref} is no longer the latest submitted version; request changes on v${latest?.version} instead`)
        return { input: { ...input, taskRef: ref }, ...bound(task, project.id), summary: `Request changes on v${version} of ${ref} (${task.title}): ${feedback}` }
      },
      async execute({ input, actor }, prepared) {
        await human.inboxAction(prepared.taskId!, { action: 'request_changes', text: input.feedback }, actor)
        return `Sent v${input.version} of ${input.taskRef} back with the feedback.`
      }
    }
  }
}
