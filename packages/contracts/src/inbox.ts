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
  // Short stored prose for task and epic items needing the human.
  message?: string
  sender: { name: string, role: AgentRole | 'system' }
  at: string
}

// A developer's one-line work note, posted as a task comment. taskRef names
// the task on an epic item, where the notes come from several tasks.
export interface InboxNote {
  text: string
  taskRef: string | null
  at: string
}

// What happened after the human last acted on an item
export interface InboxSince {
  // Their latest request for changes or answer
  at: string
  // What they said; null when they resolved the task without a word
  text: string | null
  notes: InboxNote[]
  // Always empty on a task item
  fixTasks: { id: string, ref: string, title: string }[]
}

// A file or link added since then. The kind is the evidence's, or `design`
// for a design version, whose url is its preview. Written notes have no file
// and are never listed.
export interface InboxArtifact {
  id: string
  kind: Exclude<Evidence['kind'], 'note'> | 'design'
  name: string
  url: string
  // The task it came from, on an epic item
  taskRef: string | null
  at: string
}

interface ReviewChanges {
  // Null when the human has never acted on the item
  since: InboxSince | null
  // Everything, when since is null
  newArtifacts: InboxArtifact[]
}

// An item raised by a developer or reviewer run, about a task. Needs-you
// items carry the review changes; Activity and Resolved ones don't.
export interface TaskInboxItem extends InboxItemBase, Partial<ReviewChanges> {
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
interface PlanThreadBase extends InboxItemBase {
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

export interface EpicReviewItem extends InboxItemBase, ReviewChanges {
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
export interface EpicConflictItem extends InboxItemBase, ReviewChanges {
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
  z.object({ action: z.literal('approve'), text: z.string().trim().optional() }),
  z.object({ action: z.literal('request_changes'), text: z.string().trim().min(1) }),
  z.object({ action: z.literal('delete'), text: z.string().trim().optional() })
])
export type InboxActionInput = z.infer<typeof inboxActionInput>
