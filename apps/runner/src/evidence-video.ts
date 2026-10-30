import { mkdtemp, readFile, rm, stat } from 'node:fs/promises'
import { basename, extname, join } from 'node:path'
import { exec } from './exec.ts'

// Leave 120 seconds for the upload and 15 seconds for file handling within
// Codex's 180-second MCP tool budget (codex.ts).
const CONVERT_TIMEOUT_MS = 45_000
const MAX_REASON_CHARS = 300

export type ConvertedVideo = { ok: true, fileName: string, data: Buffer } | { ok: false, error: string }

// H.264/AAC in an MP4 with the index up front, which Safari on macOS and iOS
// can play and stream. yuv420p is the only pixel format they all decode, and
// it needs even dimensions, which a browser viewport doesn't always have.
function ffmpegArgs(path: string, output: string): string[] {
  return [
    '-nostdin', '-loglevel', 'error', '-i', path,
    '-map', '0:v:0', '-map', '0:a:0?',
    '-vf', 'pad=ceil(iw/2)*2:ceil(ih/2)*2',
    '-c:v', 'libx264', '-preset', 'veryfast', '-pix_fmt', 'yuv420p',
    '-c:a', 'aac',
    '-movflags', '+faststart',
    output
  ]
}

// Converts a video to MP4 in its own folder under the scratch directory, so
// it can't overwrite the agent's files, and never throws: a caller keeps the
// original when this fails. The folder is gone again when it returns.
export async function convertToMp4(path: string, scratchDir: string, maxBytes: number): Promise<ConvertedVideo> {
  const fileName = `${basename(path, extname(path))}.mp4`
  let dir: string | null = null
  try {
    dir = await mkdtemp(join(scratchDir, 'evidence-'))
    const output = join(dir, 'converted.mp4')
    const result = await exec('ffmpeg', ffmpegArgs(path, output), { timeoutMs: CONVERT_TIMEOUT_MS })
    if (result.code !== 0) return { ok: false, error: failure(result.stderr) }
    const { size } = await stat(output)
    if (size > maxBytes) return { ok: false, error: `the MP4 is ${(size / 1024 / 1024).toFixed(1)} MB, over the ${maxBytes / 1024 / 1024} MB limit` }
    return { ok: true, fileName, data: await readFile(output) }
  } catch (error) {
    return { ok: false, error: error instanceof Error ? error.message : String(error) }
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
}

function failure(stderr: string): string {
  if (stderr.includes('ENOENT')) return 'ffmpeg is not installed on this runner'
  const reason = stderr.trim().split('\n').at(-1) ?? ''
  return reason ? `ffmpeg failed: ${reason.slice(0, MAX_REASON_CHARS)}` : 'ffmpeg failed without saying why'
}
