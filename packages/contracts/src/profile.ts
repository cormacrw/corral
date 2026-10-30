import { z } from 'zod'

// The human using Corral. Name and picture are kept on the server, so every
// browser and device sees the same profile (design/settings.md).
export interface Profile {
  id: string
  name: string
  avatarUrl: string | null
}

export const patchProfileInput = z.object({
  name: z.string().trim().min(1).max(80)
})
export type PatchProfileInput = z.infer<typeof patchProfileInput>
