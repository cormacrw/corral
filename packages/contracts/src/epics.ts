import type { EpicReviewMode, EpicReviewState } from '@corral/core'
import { z } from 'zod'
import type { Task } from './tasks.ts'

// ── Epics ───────────────────────────────────────────────────────────────────

// A group of tasks, usually one approved plan. The description is markdown.
export interface Epic {
  id: string
  projectId: string
  title: string
  description: string
  dependsOn: string[]
  blocks: string[]
  reviewMode: EpicReviewMode
  // The epic branch and its PR into the target branch (D23); null until
  // Corral creates them, and always in `direct` mode
  branch: string | null
  prNumber: number | null
  prHeadSha: string | null
  reviewState: EpicReviewState | null
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
  description: z.string().optional()
})
export type PatchEpicInput = z.infer<typeof patchEpicInput>
