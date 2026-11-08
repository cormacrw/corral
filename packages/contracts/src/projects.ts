import { EPIC_REVIEW_MODES, MERGE_METHODS, PROJECT_PREFIX_HINT, PROJECT_PREFIX_PATTERN, type EpicReviewMode, type MergeMethod } from '@corral/core'
import { z } from 'zod'

// A GitHub repository, owner/name
export const repositoryName = z.string().regex(/^[\w.-]+\/[\w.-]+$/)

export const createProjectInput = z.object({
  name: z.string().trim().min(1),
  // Derived from the name when left out
  slug: z.string().regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/).optional(),
  prefix: z.string().regex(PROJECT_PREFIX_PATTERN, PROJECT_PREFIX_HINT),
  repository: repositoryName,
  defaultBranch: z.string().trim().min(1),
  mergeMethod: z.enum(MERGE_METHODS).optional(),
  humanReviewDefault: z.boolean().optional(),
  epicReviewModeDefault: z.enum(EPIC_REVIEW_MODES).optional()
})
export type CreateProjectInput = z.infer<typeof createProjectInput>

// design/project-settings.md: one PATCH on Save; pause is its own switch
export const patchProjectInput = z.object({
  name: z.string().trim().min(1).optional(),
  prefix: z.string().regex(PROJECT_PREFIX_PATTERN, PROJECT_PREFIX_HINT).optional(),
  thumbnailColor: z.string().regex(/^#[0-9a-fA-F]{6}$/).nullable().optional(),
  defaultBranch: z.string().trim().min(1).optional(),
  mergeMethod: z.enum(MERGE_METHODS).optional(),
  requiredChecks: z.array(z.string().trim().min(1)).optional(),
  paused: z.boolean().optional(),
  humanReviewDefault: z.boolean().optional(),
  epicReviewModeDefault: z.enum(EPIC_REVIEW_MODES).optional(),
  reviewRoundCap: z.number().int().positive().optional(),
  failedRunCap: z.number().int().positive().optional()
})
export type PatchProjectInput = z.infer<typeof patchProjectInput>

// design/project-settings.md, Danger zone: the human types the project name
export const deleteProjectInput = z.object({ confirm: z.string() })

export interface Project {
  id: string
  name: string
  slug: string
  prefix: string
  thumbnailColor: string | null
  thumbnailUrl: string | null
  nextTaskNumber: number
  repository: string
  defaultBranch: string
  mergeMethod: MergeMethod
  requiredChecks: string[]
  paused: boolean
  humanReviewDefault: boolean
  // The review mode of new epics a plan doesn't give one (D27)
  epicReviewModeDefault: EpicReviewMode
  reviewRoundCap: number
  failedRunCap: number
  createdAt: string
  updatedAt: string
}
