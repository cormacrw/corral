import { IMAGE_CONTENT_TYPES, THUMBNAIL_MAX_BYTES } from '@corral/contracts'
import type { Executor } from '@corral/db'
import { blobVersion, type BlobStore } from './blob-store.ts'
import { hasImageSignature, validateImage } from './images.ts'
import { findProjectBySlug } from './projects.ts'

export function checkThumbnail(data: Uint8Array, contentType: string): void {
  validateImage(data, contentType, { maxBytes: THUMBNAIL_MAX_BYTES, field: 'file' })
}

// The hash of the project's thumbnail, refusing a stale `v`
export async function thumbnailHash(db: Executor, slug: string, version?: string): Promise<string | null> {
  const project = await findProjectBySlug(db, slug)
  if (!project.thumbnailBlob || (version !== undefined && version !== blobVersion(project.thumbnailBlob))) return null
  return project.thumbnailBlob
}

export async function readThumbnail(blobs: BlobStore, hash: string): Promise<{ data: Uint8Array, type: string } | null> {
  const data = await blobs.get(hash)
  if (!data) return null
  const type = IMAGE_CONTENT_TYPES.find(type => hasImageSignature(data, type))
  return type ? { data, type } : null
}
