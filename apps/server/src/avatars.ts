import { AVATAR_CONTENT_TYPES, AVATAR_MAX_BYTES, type PatchProfileInput, type Profile } from '@corral/contracts'
import { schema, type Executor } from '@corral/db'
import { eq } from 'drizzle-orm'
import type { BlobStore } from './blob-store.ts'
import { ApiFailure, notFound } from './errors.ts'
import { declaredImageType, hasImageSignature } from './images.ts'

const { agents, users } = schema

type AvatarType = typeof AVATAR_CONTENT_TYPES[number]

// Profile pictures for the human and the agents. The bytes go in the blob
// store like evidence; the row keeps the hash and type. URLs carry part of
// the hash, so a new picture is a new URL and the old one can be cached.
export function avatarUrl(path: string, blob: string | null): string | null {
  return blob ? `/api/${path}/avatar?v=${blob.slice(0, 12)}` : null
}

export function checkAvatar(data: Uint8Array, contentType: string | undefined): AvatarType {
  const type = declaredImageType(contentType)
  const invalid = (message: string) => new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['avatar'], message }] })
  if (!type || !AVATAR_CONTENT_TYPES.includes(type)) throw invalid('Use a PNG, JPEG, WebP or GIF image')
  if (data.byteLength === 0) throw invalid('The image is empty')
  if (data.byteLength > AVATAR_MAX_BYTES) throw invalid('The image is over 2 MB')
  if (!hasImageSignature(data, type)) throw invalid(`The file isn't a ${type.slice(6).toUpperCase()} image`)
  return type
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

export async function setUserAvatar(db: Executor, blobs: BlobStore, userId: string, image: { data: Uint8Array, type: AvatarType } | null): Promise<Profile> {
  const blob = image ? await blobs.put(image.data) : null
  await db.update(users).set({ avatarBlob: blob, avatarContentType: image?.type ?? null }).where(eq(users.id, userId))
  return getProfile(db, userId)
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

export async function setAgentAvatar(db: Executor, blobs: BlobStore, agentId: string, image: { data: Uint8Array, type: AvatarType } | null): Promise<void> {
  if (!UUID.test(agentId)) throw notFound()
  const [agent] = await db.select({ id: agents.id }).from(agents).where(eq(agents.id, agentId))
  if (!agent) throw notFound()
  const blob = image ? await blobs.put(image.data) : null
  await db.update(agents).set({ avatarBlob: blob, avatarContentType: image?.type ?? null, updatedAt: new Date() }).where(eq(agents.id, agentId))
}

// The stored picture, for the avatar endpoints
export async function readAvatar(db: Executor, blobs: BlobStore, owner: { userId: string } | { agentId: string }): Promise<{ data: Uint8Array, type: string } | null> {
  if ('agentId' in owner && !UUID.test(owner.agentId)) return null
  const [row] = 'userId' in owner
    ? await db.select({ blob: users.avatarBlob, type: users.avatarContentType }).from(users).where(eq(users.id, owner.userId))
    : await db.select({ blob: agents.avatarBlob, type: agents.avatarContentType }).from(agents).where(eq(agents.id, owner.agentId))
  if (!row?.blob || !row.type) return null
  const data = await blobs.get(row.blob)
  return data ? { data, type: row.type } : null
}
