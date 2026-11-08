import { z } from 'zod'
import type { ImageContentType } from './limits.ts'

// Images in task descriptions and comments. Uploaded as the raw body with
// its content type (POST /projects/:slug/attachments?name=), referenced in
// text as ![name](attachment:<id>) and served from `url`.

export const uploadAttachmentQuery = z.object({
  name: z.string().trim().max(200).optional()
})

export interface Attachment {
  id: string
  mimeType: ImageContentType
  fileName: string
  byteSize: number
  // /api/attachments/<id>/file
  url: string
}
