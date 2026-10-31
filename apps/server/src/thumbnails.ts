import { ATTACHMENT_CONTENT_TYPES } from '@corral/contracts'
import type { Executor } from '@corral/db'
import type { BlobStore } from './blob-store.ts'
import { ApiFailure } from './errors.ts'
import { declaredImageType, hasImageSignature } from './images.ts'
import { findProjectBySlug } from './projects.ts'

export const THUMBNAIL_MAX_BYTES = 2 * 1024 * 1024

export function checkThumbnail(data: Uint8Array, contentType: string): void {
  const invalid = (message: string, status: 400 | 413 = 400) => new ApiFailure(status, { code: 'invalid_input', issues: [{ path: ['file'], message }] })
  const type = declaredImageType(contentType)
  if (!type) throw invalid('Use a PNG, JPEG, WebP or GIF image')
  if (!data.byteLength) throw invalid('The image is empty')
  if (data.byteLength > THUMBNAIL_MAX_BYTES) throw invalid('The image is over 2 MB', 413)
  if (!hasImageSignature(data, type)) throw invalid(`The file isn't a ${type.slice(6).toUpperCase()} image`)
}

// The hash of the project's thumbnail, refusing a stale `v`
export async function thumbnailHash(db: Executor, slug: string, version?: string): Promise<string | null> {
  const project = await findProjectBySlug(db, slug)
  if (!project.thumbnailBlob || (version !== undefined && version !== project.thumbnailBlob.slice(0, 12))) return null
  return project.thumbnailBlob
}

export async function readThumbnail(blobs: BlobStore, hash: string): Promise<{ data: Uint8Array, type: string } | null> {
  const data = await blobs.get(hash)
  if (!data) return null
  const type = ATTACHMENT_CONTENT_TYPES.find(type => hasImageSignature(data, type))
  return type ? { data, type } : null
}
