import {
  AGENT_ROLES,
  DESIGN_VERSION_STATUSES,
  EVIDENCE_KINDS,
  EPIC_REVIEW_MODES,
  EPIC_REVIEW_STATES,
  MERGE_METHODS,
  PLAN_CHANGES,
  PLAN_STATUSES,
  REVIEW_VERDICTS,
  RUN_OUTCOMES,
  RUN_STATES,
  TASK_PRIORITIES,
  TASK_STATUSES,
  TASK_TYPES
} from '@corral/core'
import { pgEnum } from 'drizzle-orm/pg-core'

// Columns call these while their table is being defined, so every enum lives
// here, outside the import cycles between the table modules
export const taskStatus = pgEnum('task_status', TASK_STATUSES)
export const taskPriority = pgEnum('task_priority', TASK_PRIORITIES)
export const taskType = pgEnum('task_type', TASK_TYPES)
export const agentRole = pgEnum('agent_role', AGENT_ROLES)
export const runState = pgEnum('run_state', RUN_STATES)
export const runOutcome = pgEnum('run_outcome', RUN_OUTCOMES)
export const mergeMethod = pgEnum('merge_method', MERGE_METHODS)
export const epicReviewMode = pgEnum('epic_review_mode', EPIC_REVIEW_MODES)
export const epicReviewState = pgEnum('epic_review_state', EPIC_REVIEW_STATES)
export const planStatus = pgEnum('plan_status', PLAN_STATUSES)
export const planChange = pgEnum('plan_change', PLAN_CHANGES)
export const reviewVerdict = pgEnum('review_verdict', REVIEW_VERDICTS)
export const evidenceKind = pgEnum('evidence_kind', EVIDENCE_KINDS)
export const designVersionStatus = pgEnum('design_version_status', DESIGN_VERSION_STATUSES)
export const deploymentNotesStatus = pgEnum('deployment_notes_status', ['pending', 'ready', 'failed'])
