import type { CliId } from '@corral/core'
import { z } from 'zod'
import { repositoryName } from './projects.ts'

// ── Setup (onboarding step 2 and 3, add project) ────────────────────────────

export interface RepoChoice {
  nameWithOwner: string
  description: string | null
  isPrivate: boolean
  updatedAt: string
  defaultBranch: string
  // Shown but disabled: read-only access, or already a project (D13)
  selectable: boolean
  reason: 'read_only' | 'used_by_project' | null
  usedBy: { slug: string, name: string } | null
}

export type RepoList =
  | { signedIn: false }
  | { signedIn: true, repos: RepoChoice[], fetchedAt: string }

// refresh=1 asks GitHub again instead of the cached list
export const repoListQuery = z.object({ refresh: z.string().optional().transform(value => value === '1') })

export const checkRepoInput = z.object({ repository: repositoryName })

interface SetupCheck {
  id: 'can_push' | 'not_used' | 'cloned'
  ok: boolean
  title: string
  detail: string
}

export interface RepoCheck {
  repository: string
  defaultBranch: string | null
  checks: SetupCheck[]
  // Every check passed, so a project can be created
  ready: boolean
}

export interface CliStatus {
  id: CliId
  name: string
  version: string | null
  signedIn: boolean
}
