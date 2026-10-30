// HTTP API between apps/web and apps/server. Inputs are zod schemas the server
// validates; outputs are plain types (JSON, so dates are ISO strings).
export * from './projects.ts'
export * from './epics.ts'
export * from './tasks.ts'
export * from './designs.ts'
export * from './plans.ts'
export * from './inbox.ts'
export * from './agents.ts'
export * from './errors.ts'
export * from './setup.ts'
export * from './profile.ts'
export * from './media.ts'
export * from './pull-requests.ts'
export * from './deployments.ts'
export { AGENT_RUNTIMES, RUNTIMES_TAKING_MESSAGES, type AgentRuntime } from './agent-runtimes.ts'

// Kept here so web can label roles and statuses without importing core
export { AGENT_ROLES, EVIDENCE_KINDS, PLAN_CHANGES, PLAN_STATUSES, REVIEW_VERDICTS, TASK_PRIORITIES, TASK_STATUSES, TASK_TYPES } from '@corral/core'
export type { EvidenceKind, PlanChange, PlanStatus, ReviewVerdict } from '@corral/core'
export * from './flow-metrics.ts'
