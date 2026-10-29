import { ATTACHMENT_MAX_BYTES, type Attachment, type AttachmentContentType } from '@corral/contracts'
import { attachmentUrl, type Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { eq } from 'drizzle-orm'
import type { BlobStore } from './blob-store.ts'
import { ApiFailure } from './errors.ts'
import { declaredImageType, hasImageSignature } from './images.ts'
import { findProjectBySlug } from './projects.ts'

const { attachments } = schema

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
const EXTENSIONS: Record<AttachmentContentType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

type AttachmentRow = typeof attachments.$inferSelect

function toAttachment(row: AttachmentRow): Attachment {
  return { id: row.id, mimeType: row.mimeType as AttachmentContentType, fileName: row.fileName, byteSize: row.byteSize, url: attachmentUrl(row.id) }
}

// Only the name part, without paths or control characters
function cleanFileName(name: string | undefined, type: AttachmentContentType): string {
  const cleaned = (name ?? '').split(/[\\/]/).pop()!.replace(/\p{Cc}/gu, '').trim()
  return cleaned || `image.${EXTENSIONS[type]}`
}

// Images in task text (PNG, JPEG, WebP or GIF). The declared type must be
// one of those and match the file's first bytes; the bytes are stored once
// per content, the row once per upload.
export async function createAttachment(db: Executor, blobs: BlobStore, slug: string, upload: { data: Uint8Array, contentType: string | undefined, name: string | undefined }, actor: Actor): Promise<Attachment> {
  const project = await findProjectBySlug(db, slug)
  const { data } = upload
  const invalid = (message: string) => new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['file'], message }] })
  const type = declaredImageType(upload.contentType)
  if (!type) throw invalid('Use a PNG, JPEG, WebP or GIF image')
  if (data.byteLength === 0) throw invalid('The image is empty')
  if (data.byteLength > ATTACHMENT_MAX_BYTES) throw new ApiFailure(413, { code: 'invalid_input', issues: [{ path: ['file'], message: 'The image is over 10 MB' }] })
  if (!hasImageSignature(data, type)) throw invalid(`The file isn't a ${type.slice(6).toUpperCase()} image`)
  const blob = await blobs.put(data)
  const [row] = await db.insert(attachments).values({
    projectId: project.id,
    blob,
    mimeType: type,
    fileName: cleanFileName(upload.name, type),
    byteSize: data.byteLength,
    createdBy: actor
  }).returning()
  return toAttachment(row!)
}

// The stored image, for GET /attachments/:id/file
export async function readAttachment(db: Executor, blobs: BlobStore, id: string): Promise<{ data: Uint8Array, type: string } | null> {
  if (!UUID.test(id)) return null
  const [row] = await db.select({ blob: attachments.blob, type: attachments.mimeType }).from(attachments).where(eq(attachments.id, id))
  if (!row || !declaredImageType(row.type)) return null
  const data = await blobs.get(row.blob)
  return data ? { data, type: row.type } : null
}
