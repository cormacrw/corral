import { PLAN_CHANGES, PLAN_STATUSES, TASK_STATUSES, type EpicReviewMode, type PlanChange, type PlanStatus, type TaskPriority, type TaskStatus, type TaskType } from '@corral/core'
import { z } from 'zod'
import { agentRuntime, type AgentRuntime } from './agent-runtimes.ts'

// ── Plan (D9, design/plan.md) ─────────────────────────────────────────────

export interface PlanSession {
  id: string
  projectId: string
  title: string
  // The PM's runtime (D18), e.g. 'claude-code' or 'codex'. Locked once the
  // session has messages.
  runtime: AgentRuntime
  preview: string
  unread: boolean
  // True once its plan is approved, until the human sends another message
  closed: boolean
  // What the human has to do here, if anything
  status: 'needs_approval' | 'question' | 'none'
  // Set while a PM turn is running
  activeRunId: string | null
  createdAt: string
  updatedAt: string
}

// What a plan message says, by role and kind. Only PM questions carry a
// recommendation or options, and only when the PM gave them.
const plainPlanMessage = { text: z.string(), recommendation: z.null().default(null), options: z.null().default(null) }
export const planMessageFields = z.discriminatedUnion('role', [
  z.strictObject({ role: z.literal('human'), kind: z.literal('message'), ...plainPlanMessage }),
  z.discriminatedUnion('kind', [
    z.strictObject({ role: z.literal('pm'), kind: z.literal('message'), ...plainPlanMessage }),
    z.strictObject({ role: z.literal('pm'), kind: z.literal('error'), ...plainPlanMessage }),
    z.strictObject({
      role: z.literal('pm'),
      kind: z.literal('question'),
      text: z.string().min(1),
      recommendation: z.string().nullable().default(null),
      options: z.array(z.string()).nullable().default(null)
    })
  ])
])
export type PlanMessageFields = z.output<typeof planMessageFields>
export type NewPlanMessageFields = z.input<typeof planMessageFields>

export type PlanMessage = PlanMessageFields & {
  id: string
  sessionId: string
  planId: string | null
  runId: string | null
  createdAt: string
}
export type PlanQuestion = Extract<PlanMessageFields, { kind: 'question' }>

export const planStatus = z.enum(PLAN_STATUSES)

export const planChange = z.enum(PLAN_CHANGES)

export interface Plan {
  id: string
  sessionId: string
  projectId: string
  epicId: string | null
  version: number
  title: string
  summary: string
  status: PlanStatus
  approvedAt: string | null
  // In the order the PM gave them; epicId above is the first
  epics: { key: string, id: string, title: string, reviewMode: EpicReviewMode, dependsOn?: { id: string, title: string }[] }[]
  tasks: {
    key: string
    change: PlanChange
    // True when the plan revises an existing task rather than adding a new
    // one; its edits are staged until approval
    revises: boolean
    taskId: string | null
    epicId: string | null
    ref: string | null
    title: string
    status: TaskStatus | null
    priority: TaskPriority
    humanReview: boolean
    dependsOn: string[]
  }[]
  createdAt: string
}

// A project's Drafts by the Plan session they belong to (GET
// /projects/:slug/drafts), newest session first
export interface DraftSession {
  sessionId: string
  title: string
  updatedAt: string
  // The status of the session's latest plan version
  planStatus: PlanStatus | null
  drafts: {
    taskId: string
    ref: string
    title: string
    type: TaskType
    priority: TaskPriority
  }[]
}

export interface PlanSessionDetail extends PlanSession {
  messages: PlanMessage[]
  plans: Plan[]
}

// A client UUID makes a start safe to retry within the same project.
export const startPlanSessionInput = z.strictObject({
  id: z.uuid().optional(),
  projectId: z.uuid(),
  // The PM's runtime for this session (D18); only a CLI the runner has
  runtime: agentRuntime.default('claude-code'),
  text: z.string().trim().default(''),
  // "Refine a task": a Backlog task ref attached to the message
  taskRef: z.string().trim().optional()
}).refine(input => input.text.length > 0 || input.taskRef, { message: 'Write a message or attach a task' })
export type StartPlanSessionInput = z.infer<typeof startPlanSessionInput>

// Strict: a human message is only text, so question fields are rejected
export const planMessageInput = z.strictObject({
  text: z.string().trim().default(''),
  taskRef: z.string().trim().optional()
}).refine(input => input.text.length > 0 || input.taskRef, { message: 'Write a message or attach a task' })
export type PlanMessageInput = z.infer<typeof planMessageInput>

// Only while the session has no messages (D18)
export const patchPlanSessionInput = z.object({
  runtime: agentRuntime
})
export type PatchPlanSessionInput = z.infer<typeof patchPlanSessionInput>

// The PM's ask_question: a question, optionally with a suggested answer
// and 2–5 short answer choices
export const askQuestionInput = z.object({
  question: z.string().trim().min(1),
  recommendation: z.string().trim().min(1).optional().describe('Your suggested answer, in a few words'),
  options: z.array(z.string().trim().min(1, 'An option can’t be empty').max(120, 'An option can be at most 120 characters'))
    .min(2, 'Give 2–5 options, or leave options out').max(5, 'Give 2–5 options, or leave options out')
    .optional().describe('2–5 short answer choices')
})
export type AskQuestionInput = z.infer<typeof askQuestionInput>

// The plan's Drafts go to the board (Ready) or to the Backlog
export const approvePlanInput = z.object({
  to: z.enum(['ready', 'backlog']).default('ready')
})
export type ApprovePlanInput = z.input<typeof approvePlanInput>

export const listTasksInput = z.object({
  status: z.union([z.enum(TASK_STATUSES), z.array(z.enum(TASK_STATUSES)).min(1)]).optional().describe('Only tasks in this status, or in any of these. Naming merged returns Merged tasks without includeMerged.'),
  epic: z.string().trim().min(1).optional().describe('Only tasks in this epic, by the epic id from list_tasks'),
  query: z.string().trim().min(1).optional().describe('Only tasks whose ref or title contains this, ignoring case'),
  includeMerged: z.boolean().default(false).describe('Also return Merged tasks; they are left out by default')
})
export type ListTasksInput = z.infer<typeof listTasksInput>
