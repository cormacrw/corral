import { ATTACHMENT_MAX_BYTES, type Attachment, type ImageContentType } from '@corral/contracts'
import { attachmentIdsInMarkdown, attachmentIdsInRichText, attachmentUrl, isUuid, type Actor } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { and, eq, inArray } from 'drizzle-orm'
import type { BlobHandle, BlobStore } from './blob-store.ts'
import { declaredImageType, validateImage } from './images.ts'
import { findProjectBySlug } from './projects.ts'

const { attachments } = schema

const EXTENSIONS: Record<ImageContentType, string> = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }

type AttachmentRow = typeof attachments.$inferSelect

function toAttachment(row: AttachmentRow): Attachment {
  return { id: row.id, mimeType: row.mimeType as ImageContentType, fileName: row.fileName, byteSize: row.byteSize, url: attachmentUrl(row.id) }
}

function cleanFileName(name: string | undefined, type: ImageContentType): string {
  const cleaned = (name ?? '').split(/[\\/]/).pop()!.replace(/\p{Cc}/gu, '').trim()
  return cleaned || `image.${EXTENSIONS[type]}`
}

// Images in task text (PNG, JPEG, WebP or GIF). The declared type must be
// one of those and match the file's first bytes; the bytes are stored once
// per content, the row once per upload.
export async function createAttachment(db: Executor, blobs: BlobStore, slug: string, upload: { data: Uint8Array, contentType: string | undefined, name: string | undefined }, actor: Actor): Promise<Attachment> {
  const project = await findProjectBySlug(db, slug)
  const { data } = upload
  const type = validateImage(data, upload.contentType, { maxBytes: ATTACHMENT_MAX_BYTES, field: 'file' })
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

export async function readAttachment(db: Executor, blobs: BlobStore, id: string): Promise<{ file: BlobHandle, type: string } | null> {
  if (!isUuid(id)) return null
  const [row] = await db.select({ blob: attachments.blob, type: attachments.mimeType }).from(attachments).where(eq(attachments.id, id))
  if (!row || !declaredImageType(row.type)) return null
  const file = await blobs.open(row.blob)
  return file ? { file, type: row.type } : null
}

// An attachment with its bytes, only if it belongs to the project: for the
// agents' get_attachment tool, which must not read across projects
export async function readProjectAttachment(db: Executor, blobs: BlobStore, projectId: string, id: string): Promise<{ id: string, fileName: string, mimeType: ImageContentType, byteSize: number, data: Uint8Array } | null> {
  if (!isUuid(id)) return null
  const [row] = await db.select().from(attachments).where(and(eq(attachments.id, id), eq(attachments.projectId, projectId)))
  const mimeType = row ? declaredImageType(row.mimeType) : null
  if (!row || !mimeType) return null
  const data = await blobs.get(row.blob)
  return data ? { id: row.id, fileName: row.fileName, mimeType, byteSize: row.byteSize, data } : null
}

export interface TaskAttachment {
  id: string
  fileName: string
  // Where the task text references it: "the description", "a comment by …"
  foundIn: string[]
}

// The project's attachments referenced in a task's description,
// implementation plan and comments, once each, in order of appearance, for the agents' prompts and
// get_task. References to images outside the project are left out.
export async function listTaskAttachments(db: Executor, projectId: string, task: { description: unknown, implementationPlan?: unknown }, comments: { author: string, body: string, createdAt: Date }[]): Promise<TaskAttachment[]> {
  const found = new Map<string, string[]>()
  const note = (ids: string[], where: string) => {
    for (const id of ids) found.set(id, [...found.get(id) ?? [], where])
  }
  note(attachmentIdsInRichText(task.description), 'the description')
  note(attachmentIdsInRichText(task.implementationPlan), 'the implementation plan')
  for (const c of comments) note(attachmentIdsInMarkdown(c.body), `a comment by ${c.author} (${c.createdAt.toISOString()})`)
  if (found.size === 0) return []
  const rows = await db.select({ id: attachments.id, fileName: attachments.fileName }).from(attachments)
    .where(and(eq(attachments.projectId, projectId), inArray(attachments.id, [...found.keys()])))
  const names = new Map(rows.map(r => [r.id, r.fileName]))
  return [...found].filter(([id]) => names.has(id)).map(([id, foundIn]) => ({ id, fileName: names.get(id)!, foundIn }))
}
