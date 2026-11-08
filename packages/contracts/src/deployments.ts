import type { DeploymentCommit, DeploymentNotesStatus } from '@corral/core'
import { z } from 'zod'
import { repositoryName } from './projects.ts'

const commitSha = z.string().regex(/^[0-9a-f]{40}$/)

// What scripts/deploy/auto-deploy.sh posts after `docker compose up -d`
// (D16). The project is the one whose repository is `repository`. Posting
// the same toSha again returns the existing deployment.
export const createDeploymentInput = z.object({
  repository: repositoryName,
  // Null for the first deploy
  fromSha: commitSha.nullable(),
  toSha: commitSha,
  // Newest first, as `git log` lists them. Every commit in the range, however
  // many: a capped list would lose the oldest and the PM's notes with them.
  commits: z.array(z.object({ sha: commitSha, subject: z.string() }) satisfies z.ZodType<DeploymentCommit>)
})
export type CreateDeploymentInput = z.infer<typeof createDeploymentInput>

export interface Deployment {
  id: string
  projectId: string
  fromSha: string | null
  toSha: string
  commits: DeploymentCommit[]
  // The PM's release notes in markdown, once notesStatus is ready
  notes: string | null
  notesStatus: DeploymentNotesStatus
  readAt: string | null
  createdAt: string
}
