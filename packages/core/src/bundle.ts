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

// Why an archive can't be read. The message names the entry or offset.
export class BundleError extends Error {}

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

// The numeric header fields checked on every entry, by offset. tar pads them
// with spaces or NULs, and uses base-256 for values too big for octal.
const NUMERIC_FIELDS = [
  { name: 'mode', offset: 100, length: 8 },
  { name: 'uid', offset: 108, length: 8 },
  { name: 'gid', offset: 116, length: 8 },
  { name: 'size', offset: 124, length: 12 },
  { name: 'mtime', offset: 136, length: 12 },
  { name: 'checksum', offset: 148, length: 8 }
]

function numeric(header: Uint8Array, offset: number, length: number): number | null {
  const bytes = header.subarray(offset, offset + length)
  const first = bytes[0]!
  if (first === 0x80 || first === 0xff) {
    return bytes.subarray(1).reduce((value, b) => value * 256 + b, first === 0xff ? -1 : 0)
  }
  const match = /^ *([0-7]*)[ \0]*$/.exec(String.fromCharCode(...bytes))
  if (!match) return null
  return match[1] ? Number.parseInt(match[1], 8) : 0
}

// tar sums the header with the checksum field read as spaces. Old writers
// summed signed bytes, so GNU tar accepts both and so does this.
function checksumMatches(header: Uint8Array, expected: number): boolean {
  let unsigned = 0
  let signed = 0
  header.forEach((b, i) => {
    const byte = i >= 148 && i < 156 ? 0x20 : b
    unsigned += byte
    signed += byte < 0x80 ? byte : byte - 0x100
  })
  return expected === unsigned || expected === signed
}

// The `path` record of a pax extended header. Each record is
// `<length> <key>=<value>\n`, where the length is in bytes and counts the
// whole record, so a value may contain newlines. `where` names the entry
// in errors.
function paxPath(data: Uint8Array, where: string): string | null {
  let path: string | null = null
  let at = 0
  while (at < data.byteLength) {
    const space = data.indexOf(0x20, at)
    const digits = space === -1 ? '' : decoder.decode(data.subarray(at, space))
    const end = at + Number(digits)
    const record = /^[1-9]\d*$/.test(digits) && end > space + 1 && end <= data.byteLength && data[end - 1] === 0x0a
      ? decoder.decode(data.subarray(space + 1, end - 1))
      : null
    const equals = record?.indexOf('=') ?? -1
    if (equals < 1) throw new BundleError(`Bad pax record at byte ${at} of ${where}`)
    if (record!.slice(0, equals) === 'path') path = record!.slice(equals + 1)
    at = end
  }
  return path
}

function allZero(bytes: Uint8Array): boolean {
  return bytes.every(b => b === 0)
}

// The regular files in a tar archive, by path. Folders, links and other
// entries are skipped on purpose, and so is any file whose name isn't a safe
// bundle path. Everything else must be sound: a malformed archive throws a
// BundleError naming the entry and offset, never a partial result. That
// covers a header that fails its checksum or has a bad numeric field, a
// truncated archive, a bad extended header and data after the end-of-archive
// marker. Two files with the same path are also rejected, rather than one
// silently replacing the other: `tar -cf` on a folder never writes them, so
// they mean the archive isn't what it claims to be.
export function unpackBundle(archive: Uint8Array): Map<string, Uint8Array> {
  const files = new Map<string, Uint8Array>()
  const seen = new Map<string, string>()
  let offset = 0
  let longName: string | null = null
  for (let entry = 1; ; entry++) {
    const header = archive.subarray(offset, offset + BLOCK)
    if (header.byteLength === 0) throw new BundleError(`Truncated tar archive: no end-of-archive marker at offset ${offset} (entry ${entry})`)
    if (header.byteLength < BLOCK) throw new BundleError(`Truncated tar archive: entry ${entry} at offset ${offset} has ${header.byteLength} of ${BLOCK} header bytes`)
    if (allZero(header)) {
      if (longName !== null) throw new BundleError(`Extended header before offset ${offset} has no entry to apply to`)
      const rest = archive.subarray(offset)
      if (rest.byteLength < BLOCK * 2) throw new BundleError(`Truncated tar archive: incomplete end-of-archive marker at offset ${offset}`)
      if (!allZero(rest)) throw new BundleError(`Data after the end-of-archive marker at offset ${offset}`)
      return files
    }

    const headerName = field(header, 0, 100)
    // Only ustar has a prefix here. GNU keeps other data in these bytes.
    const prefix = field(header, 257, 6) === 'ustar' ? field(header, 345, 155) : ''
    const name: string = longName ?? (prefix ? `${prefix}/${headerName}` : headerName)
    const where: string = `entry ${entry}${name ? ` (${JSON.stringify(name.slice(0, 120))})` : ''} at offset ${offset}`
    for (const f of NUMERIC_FIELDS) {
      if (numeric(header, f.offset, f.length) === null) throw new BundleError(`Bad ${f.name} field in ${where}`)
    }
    if (!checksumMatches(header, numeric(header, 148, 8)!)) throw new BundleError(`Bad header checksum in ${where}`)
    const size = numeric(header, 124, 12)!
    if (!Number.isSafeInteger(size) || size < 0) throw new BundleError(`Bad size field in ${where}`)
    const start = offset + BLOCK
    const blocks = Math.ceil(size / BLOCK) * BLOCK
    if (start + blocks > archive.byteLength) {
      throw new BundleError(`Truncated tar archive: ${where} needs ${blocks} bytes of data, ${archive.byteLength - start} left`)
    }
    const data = archive.subarray(start, start + size)
    offset = start + blocks
    const type = String.fromCharCode(header[156]!)
    if (type === 'L') {
      longName = field(data, 0, data.byteLength)
      if (!longName) throw new BundleError(`Empty long name in ${where}`)
      continue
    }
    if (type === 'x') {
      longName = paxPath(data, where) ?? longName
      continue
    }
    if (type === 'g') {
      paxPath(data, where)
      continue
    }
    if (type === 'K') continue
    longName = null
    if (type !== '0' && type !== '\0') continue
    const relative = name.replace(/^(\.\/)+/, '')
    const path = relative ? bundlePath(relative) : null
    if (!path || name.endsWith('/')) continue
    const first = seen.get(path)
    if (first) throw new BundleError(`Duplicate path ${JSON.stringify(path)}: ${where} repeats ${first}`)
    seen.set(path, where)
    files.set(path, data.slice())
  }
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
