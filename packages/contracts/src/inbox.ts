import type { AgentRole, EpicFixKind, EpicRebaseDecision } from '@corral/core'
import { z } from 'zod'
import type { AgentRuntime } from './agent-runtimes.ts'
import type { Deployment } from './deployments.ts'
import type { Plan, PlanQuestion } from './plans.ts'
import type { Evidence, Task } from './tasks.ts'

// ── Inbox (D11, design/inbox.md) ───────────────────────────────────────────

export type TaskInboxItemType = 'human_review' | 'question' | 'blocked' | 'failed' | 'stopped' | 'activity'
export type InboxItemType = TaskInboxItemType | 'plan_thread' | 'epic_review' | 'release_notes' | 'epic_conflict' | 'runner_update'

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
  // An epic rebase's question, with its alternatives and affected changes
  decision?: EpicRebaseDecision
}

// Something the PM did that isn't about one task, such as changing a project's
// settings. Its body links to the PM conversation that did it.
export interface PmActivityItem extends InboxItemBase {
  id: string
  type: 'activity'
  epicId?: undefined
  body: string
  taskId: null
  taskRef: null
  prUrl: null
  resolution: null
}

// An open Plan session waiting on a human decision (D11): a question, a plan
// needing approval or a failed PM turn. Unread replies stay in Plan.
interface PlanThreadBase extends Omit<InboxItemBase, 'project'> {
  project: InboxItemBase['project'] | null
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
  unread: boolean
  // Set while a PM turn is running
  activeRunId: string | null
}

export type PlanThreadPlan = Pick<Plan, 'id' | 'version' | 'title' | 'summary'> & { epicCount: number, taskCount: number }

// What the thread waits on: its status always comes with what that status
// needs. 'failed' carries the error the PM's last turn ended with.
export type PlanThreadAttention =
  | { status: 'question', question: Pick<PlanQuestion, 'text' | 'recommendation' | 'options'>, plan: null, planId: null, failure: null }
  | { status: 'needs_approval', question: null, plan: PlanThreadPlan, planId: string, failure: null }
  | { status: 'failed', question: null, plan: null, planId: null, failure: string }

export type PlanThreadItem = PlanThreadBase & PlanThreadAttention

export const epicReviewActionInput = z.object({
  // `rebase` sends an epic PR conflict round the automatic rebase again.
  // `decide` answers an epic fix's question, by alternative or in writing.
  action: z.enum(['approve', 'request_changes', 'rebase', 'decide']),
  headSha: z.string().min(1),
  text: z.string().trim().optional(),
  alternative: z.number().int().min(0).optional(),
  // What the human confirmed on this approval (D27, D28). The server compares
  // these with what the epic's tasks need now, not with what the client saw.
  confirmedCriteria: z.array(z.uuid()).default([]),
  confirmedTasks: z.array(z.uuid()).default([])
}).refine(input => input.action !== 'request_changes' || Boolean(input.text), { message: 'Describe the changes needed', path: ['text'] })
  .refine(input => input.action !== 'decide' || input.alternative !== undefined || Boolean(input.text), { message: 'Pick an alternative or write an answer', path: ['text'] })
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
  tasks: EpicReviewTask[]
}

// A task on the epic review. `humanReview` and `humanChecks` (criterion IDs)
// are what the human must confirm to approve the epic. PR-free tasks skip
// task-level human review, so they carry them; task-PR tasks had it already.
export interface EpicReviewTask {
  task: Task
  evidence: Evidence[]
  humanReview: boolean
  humanChecks: string[]
}

export interface ReleaseNotesItem extends InboxItemBase {
  id: string
  type: 'release_notes'
  epicId?: never
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

// An epic PR that couldn't rebase onto the target branch (D27)
export interface EpicConflictItem extends InboxItemBase, ReviewChanges {
  // An epic fix's question for the human (D29), which this item then is
  decision?: EpicRebaseDecision
  // Recovery ran out (D11, D29): why it stopped, until Retry or the merge
  stopped?: { error: string, fix: EpicFixKind | null }
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

// A runner that can't update (COR-435). It belongs to no project: runners serve
// them all, and it clears itself once the runner reports the server's build.
export interface RunnerUpdateItem extends Omit<InboxItemBase, 'project'> {
  id: string
  type: 'runner_update'
  project: null
  runnerId: string
  online: boolean
  commit: string
  serverCommit: string
  body: string
  taskId: null
  taskRef: null
  prUrl: null
  resolution: null
}

export type InboxItem = TaskInboxItem | PmActivityItem | PlanThreadItem | EpicReviewItem | ReleaseNotesItem | EpicConflictItem | RunnerUpdateItem

// What the human owes a decision on (D11). Everything here counts.
export type ActionableInboxItem = Exclude<InboxItem, ReleaseNotesItem | PmActivityItem>

export interface Inbox {
  // Newest first by when each began waiting
  needsYou: ActionableInboxItem[]
  // Informational, newest first: what agents and the PM did, and release notes
  // until they're dismissed
  activity: (TaskInboxItem | PmActivityItem | ReleaseNotesItem)[]
  resolved: (TaskInboxItem | ReleaseNotesItem)[]
  // needsYou's length; every Inbox badge is this or its per-project share
  count: number
}

// What the human can do from an item's tray (design/inbox.md, D10)
export const inboxActionInput = z.discriminatedUnion('action', [
  // Blocked: answer the question or clarify, and continue In progress
  z.object({ action: z.literal('clarify'), text: z.string().trim().min(1) }),
  // Blocked on an epic rebase's question: one of its alternatives, or free text
  z.object({ action: z.literal('decide'), alternative: z.number().int().min(0).optional(), text: z.string().trim().min(1).optional() }).refine(d => d.alternative !== undefined || d.text, 'Pick an alternative or write an answer'),
  z.object({ action: z.literal('send_back') }),
  // Failed or Blocked: resolve to a status (D10). Also releases a no-progress stop
  z.object({ action: z.literal('resolve'), to: z.enum(['backlog', 'ready', 'in_progress']), text: z.string().trim().optional() }),
  // Stopped without progress: try again from the status it stopped in
  z.object({ action: z.literal('retry'), text: z.string().trim().optional() }),
  // Human review
  z.object({ action: z.literal('approve'), text: z.string().trim().optional() }),
  z.object({ action: z.literal('request_changes'), text: z.string().trim().min(1) }),
  z.object({ action: z.literal('delete'), text: z.string().trim().optional() })
])
export type InboxActionInput = z.infer<typeof inboxActionInput>
