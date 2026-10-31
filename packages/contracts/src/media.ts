import { z } from 'zod'
import type { AttachmentContentType } from './client.ts'

// Profile pictures: small square images, resized in the browser before upload
export const AVATAR_CONTENT_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const AVATAR_MAX_BYTES = 2 * 1024 * 1024

// Images in task descriptions and comments. Uploaded as the raw body with
// its content type (POST /projects/:slug/attachments?name=), referenced in
// text as ![name](attachment:<id>) and served from `url`. Never SVG, which
// can carry script.
export { ATTACHMENT_CONTENT_TYPES, ATTACHMENT_MAX_BYTES, type AttachmentContentType } from './client.ts'

export const uploadAttachmentQuery = z.object({
  name: z.string().trim().max(200).optional()
})
export type UploadAttachmentQuery = z.infer<typeof uploadAttachmentQuery>

export interface Attachment {
  id: string
  mimeType: AttachmentContentType
  fileName: string
  byteSize: number
  // /api/attachments/<id>/file
  url: string
}
