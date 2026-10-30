import { z } from 'zod'
import type { CliId } from './runner.ts'

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

export const checkRepoInput = z.object({ repository: z.string().regex(/^[\w.-]+\/[\w.-]+$/) })

export interface SetupCheck {
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
