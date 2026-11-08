import { DEFAULT_AGENT_RUNTIME, PLAN_APPROVAL_TARGETS, PLAN_CHANGES, PLAN_STATUSES, type EpicReviewMode, type PlanChange, type PlanStatus, type TaskPriority, type TaskStatus, type TaskType } from '@corral/core'
import { z } from 'zod'
import type { AgentRuntime } from '@corral/core'
import { agentRuntime } from './agent-runtimes.ts'

// ── Plan (D9, design/plan.md) ─────────────────────────────────────────────

export interface PlanSession {
  parentSessionId?: string | null
  id: string
  projectId: string | null
  title: string
  // The PM's runtime (D18), e.g. 'claude-code' or 'codex'. Locked once the
  // session has messages.
  runtime: AgentRuntime
  preview: string
  unread: boolean
  // True once its plan is approved, until the human sends another message
  closed: boolean
  // What the human has to do here, if anything
  status: 'needs_approval' | 'question' | 'failed' | 'none'
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
    z.strictObject({ role: z.literal('thread'), kind: z.literal('message'), ...plainPlanMessage }),
    z.strictObject({ role: z.literal('thread'), kind: z.literal('notification'), ...plainPlanMessage })
  ]),
  z.discriminatedUnion('kind', [
    z.strictObject({ role: z.literal('pm'), kind: z.literal('message'), ...plainPlanMessage }),
    z.strictObject({ role: z.literal('pm'), kind: z.literal('error'), ...plainPlanMessage }),
    z.strictObject({ role: z.literal('pm'), kind: z.literal('confirmation'), ...plainPlanMessage }),
    z.strictObject({ role: z.literal('pm'), kind: z.literal('action_result'), ...plainPlanMessage }),
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
  senderSessionId?: string | null
  senderTitle?: string | null
  pendingAction?: import('@corral/core').PmAction | null
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
    // Markdown, staged for a revised task: the short summary, and the
    // implementation plan ('' when none)
    description: string
    implementationPlan: string
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
  projectId: z.uuid().nullable().default(null),
  // The PM's runtime for this session (D18); only a CLI the runner has
  runtime: agentRuntime.default(DEFAULT_AGENT_RUNTIME),
  text: z.string().trim().default(''),
  // "Refine a task": a Backlog task ref attached to the message
  taskRef: z.string().trim().optional()
}).refine(input => input.text.length > 0 || input.taskRef, { message: 'Write a message or attach a task' })

// Strict: a human message is only text, so question fields are rejected
export const planMessageInput = z.strictObject({
  text: z.string().trim().default(''),
  taskRef: z.string().trim().optional()
}).refine(input => input.text.length > 0 || input.taskRef, { message: 'Write a message or attach a task' })

// Only while the session has no messages (D18)
export const patchPlanSessionInput = z.object({
  runtime: agentRuntime
})

// The plan's Drafts go to the board (Ready) or to the Backlog
export const approvePlanInput = z.object({
  to: z.enum(PLAN_APPROVAL_TARGETS).default('ready')
})

// The human's answer to a PM's confirm card
export const pmActionDecisionInput = z.object({
  decision: z.enum(['confirm', 'cancel'])
})
export type PmActionDecision = z.infer<typeof pmActionDecisionInput>['decision']
