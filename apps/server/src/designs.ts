import { bundlePath, unpackBundle } from '@corral/core'
import { schema, type Executor } from '@corral/db'
import { eq } from 'drizzle-orm'
import type { BlobStore } from './blob-store.ts'
import { ApiFailure } from './errors.ts'

const { designVersions } = schema

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
