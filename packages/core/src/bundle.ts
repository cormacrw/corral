// A design version's static bundle (D20) is stored as one tar archive
// (ustar, as `tar -cf` writes it). These read and write it in memory.

export interface BundleFile {
  // Relative to the bundle folder, with forward slashes: `assets/app.js`
  path: string
  data: Uint8Array
}

export function designPreviewUrl(versionId: string): string {
  return `/api/designs/${versionId}/files/`
}

const BLOCK = 512
const decoder = new TextDecoder()
const encoder = new TextEncoder()

// A path inside a bundle, normalised, or null when it could point outside
// it: `..` or `.` segments, absolute paths, drive letters, backslashes,
// empty segments and control characters are all refused. A trailing slash
// means the folder's index.html.
export function bundlePath(raw: string): string | null {
  if (raw === '') return 'index.html'
  if (raw.startsWith('/') || raw.includes('\\') || /\p{Cc}/u.test(raw) || /^[a-z]:/i.test(raw)) return null
  const segments = raw.split('/')
  const last = segments.length - 1
  if (segments[last] === '') segments[last] = 'index.html'
  if (segments.some(s => s === '' || s === '.' || s === '..')) return null
  return segments.join('/')
}

function field(header: Uint8Array, offset: number, length: number): string {
  const bytes = header.subarray(offset, offset + length)
  const end = bytes.indexOf(0)
  return decoder.decode(end === -1 ? bytes : bytes.subarray(0, end))
}

function octal(header: Uint8Array, offset: number, length: number): number {
  const text = field(header, offset, length).trim()
  return text ? Number.parseInt(text, 8) : 0
}

// The `path` record of a pax extended header
function paxPath(data: Uint8Array): string | null {
  for (const line of decoder.decode(data).split('\n')) {
    const match = /^\d+ path=(.*)$/s.exec(line)
    if (match) return match[1]!
  }
  return null
}

// The regular files in a tar archive, by path. Folders, links and other
// entries are skipped, and so is any file whose name isn't a safe bundle
// path. Throws when the archive is malformed.
export function unpackBundle(archive: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  let offset = 0
  let longName: string | null = null
  while (offset + BLOCK <= archive.byteLength) {
    const header = archive.subarray(offset, offset + BLOCK)
    if (header.every(b => b === 0)) break
    const size = octal(header, 124, 12)
    if (!Number.isSafeInteger(size) || size < 0) throw new Error('Malformed tar header')
    const start = offset + BLOCK
    if (start + size > archive.byteLength) throw new Error('Truncated tar archive')
    const data = archive.subarray(start, start + size)
    offset = start + Math.ceil(size / BLOCK) * BLOCK
    const type = String.fromCharCode(header[156]!)
    if (type === 'L') {
      longName = field(data, 0, data.byteLength)
      continue
    }
    if (type === 'x') {
      longName = paxPath(data) ?? longName
      continue
    }
    const prefix = field(header, 345, 155)
    const name = longName ?? (prefix ? `${prefix}/${field(header, 0, 100)}` : field(header, 0, 100))
    longName = null
    if (type !== '0' && type !== '\0') continue
    const path = bundlePath(name.replace(/^(\.\/)+/, ''))
    if (path && !name.endsWith('/')) files.set(path, data.slice())
  }
  return files
}

function writeField(header: Uint8Array, offset: number, length: number, value: string) {
  header.set(encoder.encode(value).subarray(0, length), offset)
}

function writeOctal(header: Uint8Array, offset: number, length: number, value: number) {
  writeField(header, offset, length, `${value.toString(8).padStart(length - 1, '0')}\0`)
}

// A tar archive of the files. Long paths get a pax header.
export function packBundle(files: readonly BundleFile[]): Uint8Array {
  const blocks: Uint8Array[] = []
  const entry = (name: string, type: string, data: Uint8Array) => {
    const header = new Uint8Array(BLOCK)
    writeField(header, 0, 100, name)
    writeOctal(header, 100, 8, 0o644)
    writeOctal(header, 108, 8, 0)
    writeOctal(header, 116, 8, 0)
    writeOctal(header, 124, 12, data.byteLength)
    writeOctal(header, 136, 12, 0)
    header.fill(0x20, 148, 156)
    header[156] = type.charCodeAt(0)
    writeField(header, 257, 6, 'ustar')
    writeField(header, 263, 2, '00')
    writeOctal(header, 148, 8, header.reduce((sum, b) => sum + b, 0))
    blocks.push(header, data, new Uint8Array((BLOCK - (data.byteLength % BLOCK)) % BLOCK))
  }
  for (const file of files) {
    const name = encoder.encode(file.path)
    if (name.byteLength > 100) {
      // The length prefix counts itself
      const body = ` path=${file.path}\n`
      let length = encoder.encode(body).byteLength
      length += String(length + String(length).length).length
      entry('PaxHeader', 'x', encoder.encode(`${length}${body}`))
    }
    entry(file.path, '0', file.data)
  }
  blocks.push(new Uint8Array(BLOCK * 2))
  const out = new Uint8Array(blocks.reduce((sum, b) => sum + b.byteLength, 0))
  let at = 0
  for (const b of blocks) {
    out.set(b, at)
    at += b.byteLength
  }
  return out
}
