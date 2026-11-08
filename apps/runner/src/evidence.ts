import { EVIDENCE_MAX_BYTES, EVIDENCE_TOO_LARGE, megabytes } from '@corral/contracts'
import { readFile, realpath, stat } from 'node:fs/promises'
import { basename, extname, isAbsolute, relative, resolve, sep } from 'node:path'
import { convertToMp4 } from './evidence-video.ts'
import type { ToolOutcome } from './mcp.ts'

const CONTENT_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.webm': 'video/webm',
  '.mp4': 'video/mp4',
  '.m4v': 'video/x-m4v',
  '.mov': 'video/quicktime',
  '.mkv': 'video/x-matroska',
  '.avi': 'video/x-msvideo',
  '.ogv': 'video/ogg',
  '.txt': 'text/plain',
  '.log': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.html': 'text/html',
  '.har': 'application/json'
}

// Reads the file the agent attached to attach_evidence, as base64. Files must
// resolve inside the run's scratch folder, including symlink targets.
// A video other than MP4 goes up as an H.264 MP4, which Safari can play; the
// size limit applies to that copy. If there's no usable copy the original
// goes up instead, with a note saying why, so evidence is never lost.
export async function readEvidence(scratchDir: string, given: string, note: (text: string) => void): Promise<ToolOutcome> {
  if (!given) return { ok: false, error: 'Pass the path of the file to attach, or leave out path and use kind "note" for a written explanation' }
  const path = isAbsolute(given) ? given : resolve(scratchDir, given)
  const root = await realpath(scratchDir)
  const actual = await realpath(path).catch(() => null)
  if (actual) {
    const fromScratch = relative(root, actual)
    if (fromScratch === '..' || fromScratch.startsWith(`..${sep}`) || isAbsolute(fromScratch)) return { ok: false, error: 'Evidence files must be inside your scratch directory' }
  }
  const info = actual ? await stat(actual).catch(() => null) : null
  if (!info?.isFile()) return { ok: false, error: `No file at ${path}` }
  const contentType = CONTENT_TYPES[extname(path).toLowerCase()] ?? 'application/octet-stream'
  if (contentType.startsWith('video/') && contentType !== 'video/mp4') {
    const converted = await convertToMp4(actual!, scratchDir, EVIDENCE_MAX_BYTES)
    if (converted.ok) return evidenceFile(converted.fileName, 'video/mp4', converted.data)
    if (info.size > EVIDENCE_MAX_BYTES) return { ok: false, error: `Evidence files are limited to ${megabytes(EVIDENCE_MAX_BYTES)}, and ${basename(path)} could not be converted to fit: ${converted.error}` }
    note(`Attaching ${basename(path)} as it is, because it could not be converted to MP4: ${converted.error}`)
  }
  if (info.size > EVIDENCE_MAX_BYTES) return { ok: false, error: EVIDENCE_TOO_LARGE }
  const data = await readFile(actual!)
  if (data.length > EVIDENCE_MAX_BYTES) return { ok: false, error: EVIDENCE_TOO_LARGE }
  return evidenceFile(basename(path), contentType, data)
}

function evidenceFile(fileName: string, contentType: string, data: Buffer): ToolOutcome {
  return { ok: true, result: { fileName, contentType, dataBase64: data.toString('base64'), path: undefined } }
}
