import type { DesignForAgent, DesignVersion } from '@corral/contracts'
import { BundleError, bundlePath, designPreviewUrl, isUuid, taskRef, unpackBundle, type TaskEvent } from '@corral/core'
import { schema, type Executor, type TaskRow } from '@corral/db'
import { and, desc, eq, inArray, max } from 'drizzle-orm'
import { IMMUTABLE_CACHE, type BlobStore } from './blob-store.ts'
import { ApiFailure } from './errors.ts'
import { findTaskByRef } from './task-rows.ts'

const { designVersions, runs, taskDesignPins, tasks } = schema

const CONTENT_TYPES: Record<string, string> = {
  html: 'text/html; charset=utf-8',
  htm: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json; charset=utf-8',
  map: 'application/json; charset=utf-8',
  webmanifest: 'application/manifest+json; charset=utf-8',
  txt: 'text/plain; charset=utf-8',
  md: 'text/plain; charset=utf-8',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  avif: 'image/avif',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  mp4: 'video/mp4',
  webm: 'video/webm'
}

export function bundleContentType(path: string): string {
  const ext = /\.([^./]+)$/.exec(path)?.[1]?.toLowerCase()
  return (ext && CONTENT_TYPES[ext]) || 'application/octet-stream'
}

// Prototype HTML is untrusted (D20). `sandbox allow-scripts` gives it an
// opaque origin, so it can't read Corral's cookies or storage or call its
// API as Corral; the rest lets it load only the bundle's own files (and
// inline or data: ones) and make no network calls at all.
export const DESIGN_BUNDLE_CSP = [
  'sandbox allow-scripts',
  'default-src \'none\'',
  'script-src \'self\' \'unsafe-inline\' \'unsafe-eval\' blob:',
  'style-src \'self\' \'unsafe-inline\'',
  'img-src \'self\' data: blob:',
  'font-src \'self\' data:',
  'media-src \'self\' data: blob:',
  'connect-src \'none\'',
  'frame-src \'none\'',
  'worker-src \'none\'',
  'object-src \'none\'',
  'form-action \'none\'',
  'base-uri \'none\''
].join('; ')

export const DESIGN_BUNDLE_HEADERS = {
  'content-security-policy': DESIGN_BUNDLE_CSP,
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  // Module scripts and fonts are fetched in CORS mode, and the sandboxed
  // page's origin is opaque (`null`). No credentials are allowed with `*`.
  'access-control-allow-origin': '*',
  'cache-control': IMMUTABLE_CACHE
}

// Unpacked bundles by blob hash, oldest use first. Bundles are immutable, so
// entries never go stale. The cache holds the load, so the assets of one page
// share a single unpack, and is bounded by what's unpacked; the newest bundle
// stays even over the bound, as its page is still asking for it.
const MAX_CACHED_BYTES = 64 * 1024 * 1024
const unpacked = new Map<string, { files: Promise<Map<string, Uint8Array> | null>, bytes: number }>()

function loadBundle(blobs: BlobStore, hash: string): Promise<Map<string, Uint8Array> | null> {
  const cached = unpacked.get(hash)
  if (cached) {
    unpacked.delete(hash)
    unpacked.set(hash, cached)
    return cached.files
  }
  const entry = { files: unpackBlob(blobs, hash), bytes: 0 }
  unpacked.set(hash, entry)
  void entry.files.then((files) => {
    // Nothing to keep: the next request tries again
    if (!files) {
      unpacked.delete(hash)
      return
    }
    entry.bytes = [...files.values()].reduce((total, data) => total + data.byteLength, 0)
    let total = [...unpacked.values()].reduce((sum, e) => sum + e.bytes, 0)
    for (const [key, { bytes }] of unpacked) {
      if (total <= MAX_CACHED_BYTES || unpacked.size === 1) break
      if (bytes > 0) {
        unpacked.delete(key)
        total -= bytes
      }
    }
  }, () => unpacked.delete(hash))
  return entry.files
}

async function unpackBlob(blobs: BlobStore, hash: string): Promise<Map<string, Uint8Array> | null> {
  const archive = await blobs.get(hash)
  if (!archive) return null
  try {
    return unpackBundle(archive)
  } catch (error) {
    if (error instanceof BundleError) return null
    throw error
  }
}

// One file of a design version's bundle, for GET /designs/:versionId/files/*.
// `rawPath` is the request path after `files/`, still percent-encoded, so
// an encoded `..` or slash is caught too.
export async function readDesignFile(db: Executor, blobs: BlobStore, versionId: string, rawPath: string): Promise<{ data: Uint8Array, type: string } | null> {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch (error) {
    if (!(error instanceof URIError)) throw error
    decoded = '\0'
  }
  const path = bundlePath(decoded)
  if (!path) {
    throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['path'], message: 'Use a relative path inside the bundle' }] })
  }
  if (!isUuid(versionId)) return null
  const [row] = await db.select({ blob: designVersions.bundleBlob }).from(designVersions).where(eq(designVersions.id, versionId))
  if (!row) return null
  const data = (await loadBundle(blobs, row.blob))?.get(path)
  return data ? { data, type: bundleContentType(path) } : null
}

export class DesignNotFound extends Error {}

// Reads a design version by the ref of its design task, or of a build task
// pinned to one. With no version, a design task gives its latest version and
// a build task its pinned one. Only this project's tasks are read.
export async function readDesign(db: Executor, blobs: BlobStore, project: { id: string, prefix: string }, ref: string, version?: number): Promise<DesignForAgent> {
  const task = await findTaskByRef(db, project, ref)

  let designTaskId = task.id
  let pinnedScreens: string[] | null = null
  let wanted = version
  if (task.type !== 'design') {
    const [pin] = await db.select({ screens: taskDesignPins.screens, taskId: designVersions.taskId, version: designVersions.version }).from(taskDesignPins)
      .innerJoin(designVersions, eq(designVersions.id, taskDesignPins.designVersionId)).where(eq(taskDesignPins.taskId, task.id))
    if (!pin) throw new DesignNotFound(`${ref} is neither a design task nor pinned to a design`)
    designTaskId = pin.taskId
    pinnedScreens = pin.screens
    wanted ??= pin.version
  }

  const [row] = await db.select().from(designVersions)
    .where(and(eq(designVersions.taskId, designTaskId), wanted === undefined ? undefined : eq(designVersions.version, wanted)))
    .orderBy(desc(designVersions.version)).limit(1)
  if (!row) throw new DesignNotFound(wanted === undefined ? `${ref} has no design versions yet` : `${ref} has no design version v${wanted}`)
  const [designTask] = designTaskId === task.id ? [task] : await db.select().from(tasks).where(eq(tasks.id, designTaskId))

  const read = async (hash: string, what: string) => {
    const data = await blobs.get(hash)
    if (!data) throw new DesignNotFound(`The ${what} of design v${row.version} is missing from the blob store`)
    return Buffer.from(data)
  }
  return {
    taskRef: taskRef(project.prefix, designTask!.number),
    title: designTask!.title,
    version: row.version,
    status: row.status,
    branch: row.branch,
    commitSha: row.commitSha,
    spec: (await read(row.specBlob, 'spec')).toString('utf8'),
    pinnedScreens,
    screenshots: await Promise.all(row.screenshots.map(async s => ({ fileName: s.fileName, contentType: s.contentType, dataBase64: (await read(s.blob, `screenshot ${s.fileName}`)).toString('base64') }))),
    bundle: { dataBase64: (await read(row.bundleBlob, 'bundle')).toString('base64') }
  }
}

// Why a tar can't be a design bundle, or null when it can: it must be a sound
// archive with index.html at its root (D20), so the preview can serve it on
// its own. The bundle is untrusted, so this reads it in memory.
export function bundleProblem(archive: Uint8Array): string | null {
  try {
    if (unpackBundle(archive).has('index.html')) return null
    return 'The bundle has no index.html at its root. Pass the folder that holds index.html and its assets, with relative paths.'
  } catch (error) {
    if (error instanceof BundleError) return `The bundle is not a valid tar archive. ${error.message}.`
    throw error
  }
}

// A design task's versions for the design view (D20), newest first. The
// spec comes inline; the bundle and screenshots by URL.
export async function listDesignVersions(db: Executor, blobs: BlobStore, taskId: string): Promise<DesignVersion[]> {
  const rows = await db.select().from(designVersions).where(eq(designVersions.taskId, taskId)).orderBy(desc(designVersions.version))
  return Promise.all(rows.map(async row => ({
    id: row.id,
    version: row.version,
    status: row.status,
    branch: row.branch,
    commitSha: row.commitSha,
    spec: Buffer.from(await blobs.get(row.specBlob) ?? new Uint8Array()).toString('utf8'),
    screenshots: row.screenshots.map((s, i) => ({ fileName: s.fileName, url: `/api/designs/${row.id}/screenshots/${i}` })),
    previewUrl: designPreviewUrl(row.id),
    feedback: row.feedback,
    planSessionId: row.planSessionId,
    createdAt: row.createdAt.toISOString()
  })))
}

// One of a version's screenshots. They're the agent's files, so they get
// the bundle's sandbox headers too (an SVG can carry script).
export async function readDesignScreenshot(db: Executor, blobs: BlobStore, versionId: string, index: number): Promise<{ data: Uint8Array, type: string } | null> {
  if (!isUuid(versionId) || !Number.isInteger(index) || index < 0) return null
  const [row] = await db.select({ screenshots: designVersions.screenshots }).from(designVersions).where(eq(designVersions.id, versionId))
  const shot = row?.screenshots[index]
  const data = shot ? await blobs.get(shot.blob) : null
  return shot && data ? { data, type: bundleContentType(shot.fileName) } : null
}

// D20: a design version sent back, by the reviewer or the human, is kept
// unchanged except for its status; the next submission is a new version.
// Called with the transition that sends it back.
export async function sendBackDesignVersion(tx: Executor, task: Pick<TaskRow, 'id' | 'type'>, event: TaskEvent): Promise<void> {
  if (task.type !== 'design' || (event.type !== 'changes_requested' && event.type !== 'human_request_changes')) return
  const [latest] = await tx.select({ id: designVersions.id }).from(designVersions)
    .where(and(eq(designVersions.taskId, task.id), eq(designVersions.status, 'submitted'))).orderBy(desc(designVersions.version)).limit(1)
  if (!latest) return
  await tx.update(designVersions).set({ status: 'changes_requested', ...(event.type === 'human_request_changes' && event.feedback && { feedback: event.feedback }), updatedAt: new Date() })
    .where(eq(designVersions.id, latest.id))
}

// What decides whether pins are stale (D20): each design's latest approved
// version, and which of the tasks have had a run
export async function pinStaleness(db: Executor, designTaskIds: string[], taskIds: string[]): Promise<{ latestApproved: Map<string, number>, started: Set<string> }> {
  const latestApproved = new Map<string, number>()
  const started = new Set<string>()
  if (designTaskIds.length === 0) return { latestApproved, started }
  const approved = await db.select({ taskId: designVersions.taskId, version: max(designVersions.version) }).from(designVersions)
    .where(and(inArray(designVersions.taskId, [...new Set(designTaskIds)]), eq(designVersions.status, 'approved'))).groupBy(designVersions.taskId)
  for (const a of approved) if (a.version !== null) latestApproved.set(a.taskId, a.version)
  const ran = await db.selectDistinct({ taskId: runs.taskId }).from(runs).where(inArray(runs.taskId, taskIds))
  for (const r of ran) if (r.taskId) started.add(r.taskId)
  return { latestApproved, started }
}

// The tasks' design pins, with what decides whether each is stale (D20)
export async function designPins(db: Executor, taskIds: string[]) {
  const pins = await db
    .select({ taskId: taskDesignPins.taskId, screens: taskDesignPins.screens, version: designVersions.version, designTaskId: designVersions.taskId, number: tasks.number })
    .from(taskDesignPins)
    .innerJoin(designVersions, eq(designVersions.id, taskDesignPins.designVersionId))
    .innerJoin(tasks, eq(tasks.id, designVersions.taskId))
    .where(inArray(taskDesignPins.taskId, taskIds))
  const { latestApproved, started } = await pinStaleness(db, pins.map(p => p.designTaskId), pins.map(p => p.taskId))
  return { pins, latestApproved, started }
}

// Pins a build task to a design version and its screens (D20), or unpins it
export async function setDesignPin(db: Executor, taskId: string, pin: { designVersionId: string, screens: string[] } | null): Promise<void> {
  if (!pin) {
    await db.delete(taskDesignPins).where(eq(taskDesignPins.taskId, taskId))
    return
  }
  await db.insert(taskDesignPins).values({ taskId, ...pin })
    .onConflictDoUpdate({ target: taskDesignPins.taskId, set: { ...pin, updatedAt: new Date() } })
}
