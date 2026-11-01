import { EPIC_REVIEW_MODES, type EpicReviewMode, type EpicReviewState } from '@corral/core'
import { z } from 'zod'
import type { Task } from './tasks.ts'

// ── Epics ───────────────────────────────────────────────────────────────────

// Corral keeping the epic branch on top of its target branch (D27). Only
// `failed` needs anyone: it's an operational stop that a retry clears.
export type EpicSync =
  | { state: 'rebasing' }
  | { state: 'resolving', files: string[], taskId: string | null, taskRef: string | null }
  | { state: 'deciding', question: string, taskId: string | null, taskRef: string | null }
  | { state: 'failed', error: string }

// One line of an epic's own history: what happened, by whom, on which commits
export interface EpicHistoryEntry {
  id: string
  at: string
  actor: string
  event: string
  text: string
  detail: Record<string, unknown>
}

// A group of tasks, usually one approved plan. The description is markdown.
export interface Epic {
  id: string
  projectId: string
  title: string
  description: string
  dependsOn: string[]
  blocks: string[]
  reviewMode: EpicReviewMode
  // The epic branch and its PR into the target branch (D27); null until
  // Corral creates them, and always in `direct` mode
  branch: string | null
  prNumber: number | null
  prUrl: string | null
  prHeadSha: string | null
  // The commit the current approval was given on, and the target commit its
  // head now sits on (COR-291)
  approvedHeadSha: string | null
  approvedBaseSha: string | null
  reviewState: EpicReviewState | null
  sync: EpicSync | null
  // True once a task has opened a PR or merged: its work already went to the
  // mode's branch, so the review mode can't change any more
  reviewModeLocked: boolean
  // Tasks outside Draft and Backlog, and how many of them are merged
  taskCount: number
  mergedCount: number
  createdAt: string
  updatedAt: string
}

// The epic with every task in it, Drafts included, for the dependency canvas
export interface EpicDetail extends Epic {
  tasks: Task[]
}

export const setEpicDependenciesInput = z.object({ dependsOn: z.array(z.uuid()) })
export type SetEpicDependenciesInput = z.infer<typeof setEpicDependenciesInput>

export const patchEpicInput = z.object({
  title: z.string().trim().min(1).optional(),
  description: z.string().optional(),
  reviewMode: z.enum(EPIC_REVIEW_MODES).optional()
})
export type PatchEpicInput = z.infer<typeof patchEpicInput>
