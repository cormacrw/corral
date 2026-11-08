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

// A design version as the agents' get_design tool returns it (D20). The
// bundle and screenshots travel as base64; the runner writes them to the
// agent's scratch folder and extracts the bundle there.
export interface DesignForAgent {
  taskRef: string
  title: string
  version: number
  status: DesignVersionStatus
  branch: string
  commitSha: string
  // design.md, as the developer wrote it
  spec: string
  // The screens a build task is pinned to; null when read from the design task
  pinnedScreens: string[] | null
  screenshots: { fileName: string, contentType: string, dataBase64: string }[]
  // The static bundle, a tar of index.html and its assets
  bundle: { dataBase64: string }
}

// Approving a design version (D20). The note goes to the PM in the Plan
// session the approval opens.
export const approveDesignInput = z.object({
  note: z.string().trim().max(10_000).optional()
})
