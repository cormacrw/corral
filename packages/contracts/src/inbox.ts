import type { AgentRole } from '@corral/core'
import { z } from 'zod'
import type { AgentRuntime } from './agent-runtimes.ts'
import type { Deployment } from './deployments.ts'
import type { Plan, PlanMessage, PlanSession } from './plans.ts'
import type { Evidence, Task } from './tasks.ts'

// ── Inbox (D11, design/inbox.md) ───────────────────────────────────────────

export type TaskInboxItemType = 'human_review' | 'question' | 'blocked' | 'failed' | 'activity'
export type InboxItemType = TaskInboxItemType | 'plan_thread' | 'epic_review' | 'release_notes' | 'epic_conflict'

interface InboxItemBase {
  project: { id: string, slug: string, name: string, thumbnailColor: string | null, thumbnailUrl: string | null }
  subject: string
  preview: string
  sender: { name: string, role: AgentRole | 'system' }
  at: string
}

// An item raised by a developer or reviewer run, about a task
export interface TaskInboxItem extends InboxItemBase {
  // Epic PR activity links to the epic while retaining task context.
  epicId?: string
  body: string
  // The task ID for Needs-you items; the audit entry for Activity and Resolved
  id: string
  type: TaskInboxItemType
  taskId: string
  taskRef: string
  prUrl: string | null
  // Set on Resolved items: what the human did
  resolution: string | null
}

// An open Plan session waiting on the human (D11, amended): a question, a plan
// needing approval or an unread PM reply
export interface PlanThreadItem extends InboxItemBase {
  // The session ID
  id: string
  type: 'plan_thread'
  // Not about a task, so these are always null
  taskId: null
  taskRef: null
  prUrl: null
  resolution: null
  sessionId: string
  runtime: AgentRuntime
  status: PlanSession['status']
  question: Pick<PlanMessage, 'text' | 'recommendation' | 'options'> | null
  // The latest PM message, when the thread is listed only for an unread reply
  reply: string | null
  plan: (Pick<Plan, 'id' | 'version' | 'title' | 'summary'> & { epicCount: number, taskCount: number }) | null
  unread: boolean
  // The plan waiting for approval, when status is needs_approval
  planId: string | null
  // Set while a PM turn is running
  activeRunId: string | null
}

export const epicReviewActionInput = z.object({
  // `rebase` hands an epic PR conflict to a developer run
  action: z.enum(['approve', 'request_changes', 'rebase']),
  headSha: z.string().min(1),
  text: z.string().trim().optional()
}).refine(input => input.action !== 'request_changes' || Boolean(input.text), { message: 'Describe the changes needed', path: ['text'] })
export type EpicReviewActionInput = z.input<typeof epicReviewActionInput>

export interface EpicReviewItem extends InboxItemBase {
  id: string
  type: 'epic_review'
  epicId: string
  taskId: null
  taskRef: null
  prUrl: string
  body: string
  resolution: null
  headSha: string
  tasks: { task: Task, evidence: Evidence[] }[]
}

export interface ReleaseNotesItem extends InboxItemBase {
  id: string
  type: 'release_notes'
  deploymentId: string
  fromSha: string | null
  toSha: string
  notes: string | null
  notesStatus: Deployment['notesStatus']
  unread: boolean
  taskId: null
  taskRef: null
  prUrl: null
  resolution: string | null
}

export function needsAttention(item: InboxItem): boolean {
  return item.type !== 'release_notes'
}

// An epic PR that couldn't rebase onto the target branch (D27)
export interface EpicConflictItem extends InboxItemBase {
  id: string
  type: 'epic_conflict'
  epicId: string
  taskId: null
  taskRef: null
  prUrl: string
  body: string
  resolution: null
  headSha: string
  targetBranch: string
  // Empty when the runner couldn't work them out
  files: string[]
}

export type InboxItem = TaskInboxItem | PlanThreadItem | EpicReviewItem | ReleaseNotesItem | EpicConflictItem

export interface Inbox {
  // Attention items newest first, followed by undismissed release notes
  // newest first. Release notes remain here after reading.
  needsYou: InboxItem[]
  activity: TaskInboxItem[]
  resolved: (TaskInboxItem | ReleaseNotesItem)[]
  // The Needs you count excludes informational release notes
  count: number
}

// What the human can do from an item's tray (design/inbox.md, D10)
export const inboxActionInput = z.discriminatedUnion('action', [
  // Blocked: answer the question or clarify, and continue In progress
  z.object({ action: z.literal('clarify'), text: z.string().trim().min(1) }),
  z.object({ action: z.literal('send_back') }),
  // Failed or Blocked: resolve to a status (D10)
  z.object({ action: z.literal('resolve'), to: z.enum(['backlog', 'ready', 'in_progress']), text: z.string().trim().optional() }),
  // Human review
  z.object({ action: z.literal('approve') }),
  z.object({ action: z.literal('request_changes'), text: z.string().trim().min(1) }),
  z.object({ action: z.literal('delete'), text: z.string().trim().optional() })
])
export type InboxActionInput = z.infer<typeof inboxActionInput>
