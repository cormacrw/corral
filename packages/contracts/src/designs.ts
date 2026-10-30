import type { DesignVersionStatus } from '@corral/core'
import { z } from 'zod'

// A design task's version as the design view shows it (D20). The bundle is
// served sandboxed under previewUrl; screenshots by their own URLs.
export interface DesignVersion {
  id: string
  version: number
  status: DesignVersionStatus
  branch: string
  commitSha: string
  // design.md, as the developer wrote it
  spec: string
  screenshots: { fileName: string, url: string }[]
  previewUrl: string
  // The human's feedback when they requested changes
  feedback: string | null
  // The Plan session approving this version opened for its build
  planSessionId: string | null
  createdAt: string
}

// Approving a design version (D20). The note goes to the PM in the Plan
// session the approval opens.
export const approveDesignInput = z.object({
  note: z.string().trim().max(10_000).optional()
})
export type ApproveDesignInput = z.input<typeof approveDesignInput>
