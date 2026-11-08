import { isUuid } from '@corral/core'
import { AVATAR_MAX_BYTES, type ImageContentType, type PatchProfileInput, type Profile } from '@corral/contracts'
import { schema, type Executor } from '@corral/db'
import { eq } from 'drizzle-orm'
import { blobVersion, type BlobStore } from './blob-store.ts'
import { notFound } from './errors.ts'
import { validateImage } from './images.ts'

const { agents, users } = schema

type AvatarType = ImageContentType

// The write boundary accepts a complete image or removal, never separate fields.
export type AvatarImage = { data: Uint8Array, type: AvatarType } | null
type AvatarColumns =
  | { avatarBlob: string, avatarContentType: AvatarType }
  | { avatarBlob: null, avatarContentType: null }

async function storeAvatar(blobs: BlobStore, image: AvatarImage): Promise<AvatarColumns> {
  return image
    ? { avatarBlob: await blobs.put(image.data), avatarContentType: image.type }
    : { avatarBlob: null, avatarContentType: null }
}

// Profile pictures for the human and the agents. The bytes go in the blob
// store like evidence; the row keeps the hash and type. URLs carry part of
// the hash, so a new picture is a new URL and the old one can be cached.
export function avatarUrl(path: string, blob: string | null): string | null {
  return blob ? `/api/${path}/avatar?v=${blobVersion(blob)}` : null
}

export function checkAvatar(data: Uint8Array, contentType: string | undefined): AvatarType {
  return validateImage(data, contentType, { maxBytes: AVATAR_MAX_BYTES, field: 'avatar' })
}

export async function getProfile(db: Executor, userId: string): Promise<Profile> {
  const [user] = await db.select().from(users).where(eq(users.id, userId))
  if (!user) throw notFound()
  return { id: user.id, name: user.name, avatarUrl: avatarUrl('me', user.avatarBlob) }
}

export async function patchProfile(db: Executor, userId: string, input: PatchProfileInput): Promise<Profile> {
  await db.update(users).set({ name: input.name }).where(eq(users.id, userId))
  return getProfile(db, userId)
}

export async function setUserAvatar(db: Executor, blobs: BlobStore, userId: string, image: AvatarImage): Promise<Profile> {
  const avatar = await storeAvatar(blobs, image)
  await db.update(users).set(avatar).where(eq(users.id, userId))
  return getProfile(db, userId)
}

export async function setAgentAvatar(db: Executor, blobs: BlobStore, agentId: string, image: AvatarImage): Promise<void> {
  if (!isUuid(agentId)) throw notFound()
  const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId))
  if (!agent) throw notFound()
  const avatar = await storeAvatar(blobs, image)
  await db.update(agents).set({ ...avatar, updatedAt: new Date() }).where(eq(agents.id, agentId))
}

export async function readAvatar(db: Executor, blobs: BlobStore, owner: { userId: string } | { agentId: string }): Promise<{ data: Uint8Array, type: string } | null> {
  if ('agentId' in owner && !isUuid(owner.agentId)) return null
  const [row] = 'userId' in owner
    ? await db.select({ blob: users.avatarBlob, type: users.avatarContentType }).from(users).where(eq(users.id, owner.userId))
    : await db.select({ blob: agents.avatarBlob, type: agents.avatarContentType }).from(agents).where(eq(agents.id, owner.agentId))
  if (!row?.blob || !row.type) return null
  const data = await blobs.get(row.blob)
  return data ? { data, type: row.type } : null
}
