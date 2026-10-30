import type { DesignVersion } from '@corral/contracts'
import { approveDesignVersion, BundleError, bundlePath, designPreviewUrl, taskRef, unpackBundle, type Actor, type DesignVersionStatus } from '@corral/core'
import { schema, type Database, type Executor } from '@corral/db'
import { and, asc, desc, eq } from 'drizzle-orm'
import { appendAudit, auditEvent } from './audit.ts'
import type { BlobStore } from './blob-store.ts'
import { ApiFailure } from './errors.ts'
import { applyTransition, findTaskByRef, lockTask } from './tasks.ts'

const { designVersions, taskDesignPins, tasks } = schema

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

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
  // A version never changes, so its files can be cached for good
  'cache-control': 'private, max-age=31536000, immutable'
}

// Unpacked bundles by blob hash. Bundles are immutable, so entries never go
// stale; only the most recently used few are kept.
const CACHE_SIZE = 8
const unpacked = new Map<string, Map<string, Uint8Array>>()

async function loadBundle(blobs: BlobStore, hash: string): Promise<Map<string, Uint8Array> | null> {
  const cached = unpacked.get(hash)
  if (cached) {
    unpacked.delete(hash)
    unpacked.set(hash, cached)
    return cached
  }
  const archive = await blobs.get(hash)
  if (!archive) return null
  let files: Map<string, Uint8Array>
  try {
    files = unpackBundle(archive)
  } catch {
    return null
  }
  unpacked.set(hash, files)
  if (unpacked.size > CACHE_SIZE) unpacked.delete(unpacked.keys().next().value!)
  return files
}

// One file of a design version's bundle, for GET /designs/:versionId/files/*.
// `rawPath` is the request path after `files/`, still percent-encoded, so
// an encoded `..` or slash is caught too.
export async function readDesignFile(db: Executor, blobs: BlobStore, versionId: string, rawPath: string): Promise<{ data: Uint8Array, type: string } | null> {
  let decoded: string
  try {
    decoded = decodeURIComponent(rawPath)
  } catch {
    decoded = '\0'
  }
  const path = bundlePath(decoded)
  if (!path) {
    throw new ApiFailure(400, { code: 'invalid_input', issues: [{ path: ['path'], message: 'Use a relative path inside the bundle' }] })
  }
  if (!UUID.test(versionId)) return null
  const [row] = await db.select({ blob: designVersions.bundleBlob }).from(designVersions).where(eq(designVersions.id, versionId))
  if (!row) return null
  const data = (await loadBundle(blobs, row.blob))?.get(path)
  return data ? { data, type: bundleContentType(path) } : null
}

// A design version as the agents' get_design tool returns it (D20). The
// bundle and screenshots travel as base64; the runner writes them to the
// agent's scratch folder and extracts the bundle there.
export interface DesignForAgent {
  taskRef: string
  title: string
  version: number
  status: DesignVersionStatus
  branch: string
  commitSha: string
  // design.md, as the developer wrote it
  spec: string
  // The screens a build task is pinned to; null when read from the design task
  pinnedScreens: string[] | null
  screenshots: { fileName: string, contentType: string, dataBase64: string }[]
  // The static bundle, a tar of index.html and its assets
  bundle: { dataBase64: string }
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
  if (!UUID.test(versionId) || !Number.isInteger(index) || index < 0) return null
  const [row] = await db.select({ screenshots: designVersions.screenshots }).from(designVersions).where(eq(designVersions.id, versionId))
  const shot = row?.screenshots[index]
  const data = shot ? await blobs.get(shot.blob) : null
  return shot && data ? { data, type: bundleContentType(shot.fileName) } : null
}

// The human approves a version in Human review, or recovers a design left
// in Ready to merge by the old Inbox path (D20): it's
// marked approved and every earlier version superseded. Versions are
// otherwise immutable. Returns the approved version's id.
export async function approveDesign(db: Database, taskId: string, version: number | undefined, actor: Actor): Promise<string> {
  return db.transaction(async (tx) => {
    const { task, project } = await lockTask(tx, taskId)
    if (actor.kind !== 'human' || task.type !== 'design' || !['human_review', 'ready_to_merge', 'approved'].includes(task.status)) {
      throw new ApiFailure(409, { code: 'transition_rejected', reason: { code: 'invalid_transition', status: task.status, event: 'human_approve' } })
    }
    const rows = await tx.select({ id: designVersions.id, version: designVersions.version, status: designVersions.status })
      .from(designVersions).where(eq(designVersions.taskId, taskId)).orderBy(asc(designVersions.version))
    version ??= rows.filter(row => row.status === 'submitted').at(-1)?.version
    const target = rows.find(row => row.version === version)
    if (!target || (task.status === 'approved' ? target.status !== 'approved' : target.status !== 'submitted')) {
      throw new ApiFailure(409, { code: 'invalid_input', issues: [{ path: ['version'], message: 'Choose a submitted design version' }] })
    }
    if (task.status === 'approved') return target.id
    const result = approveDesignVersion(rows, target.version)
    if (!result.ok) throw new ApiFailure(409, { code: 'invalid_input', issues: [{ path: ['version'], message: result.error }] })
    for (const next of result.versions) {
      const before = rows.find(r => r.id === next.id)!
      if (before.status !== next.status) await tx.update(designVersions).set({ status: next.status, updatedAt: new Date() }).where(eq(designVersions.id, next.id))
    }
    if (task.status === 'human_review') {
      await applyTransition(tx, task, project, { type: 'human_approve' }, actor, { event: 'human_approve', headSha: null })
    } else {
      await tx.update(tasks).set({ status: 'approved', updatedAt: new Date() }).where(eq(tasks.id, taskId))
      await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('task.transition', { event: 'human_approve', headSha: task.headSha, from: task.status, to: 'approved' }))
    }
    await appendAudit(tx, { projectId: project.id, taskId, actor }, auditEvent('design.approved', { version: target.version }))
    return result.versions.find(v => v.version === target.version)!.id
  })
}
