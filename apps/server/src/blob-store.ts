import { createHash, randomUUID } from 'node:crypto'
import { mkdir, open, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Immutable, content-addressed files: evidence and run transcripts (D8).
// Local folder now, S3-compatible later under the same keys (D1).
export interface BlobStore {
  // Returns the sha256; storing the same bytes twice is a no-op
  put(data: Uint8Array): Promise<string>
  get(hash: string): Promise<Uint8Array | null>
  // For serving: the size without reading the blob, and only the bytes asked for
  open(hash: string): Promise<BlobHandle | null>
}

export interface BlobHandle {
  size: number
  // From `start` to `end` inclusive; the whole blob without them. The file is
  // opened on the first read, so a stream nobody reads holds nothing open.
  stream(start?: number, end?: number): ReadableStream<Uint8Array>
}

const CHUNK_BYTES = 64 * 1024

async function* fileChunks(path: string, start: number, end: number): AsyncGenerator<Uint8Array> {
  const file = await open(path)
  try {
    for (let position = start; position <= end;) {
      const buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, end - position + 1))
      const { bytesRead } = await file.read(buffer, 0, buffer.length, position)
      if (bytesRead === 0) return
      position += bytesRead
      yield buffer.subarray(0, bytesRead)
    }
  } finally {
    await file.close()
  }
}

const HASH = /^[0-9a-f]{64}$/

export class LocalBlobStore implements BlobStore {
  #root: string

  constructor(root: string) {
    this.#root = root
  }

  #path(hash: string): string {
    return join(this.#root, 'sha256', hash.slice(0, 2), hash.slice(2, 4), hash)
  }

  async put(data: Uint8Array): Promise<string> {
    const hash = createHash('sha256').update(data).digest('hex')
    const path = this.#path(hash)
    if (await stat(path).then(() => true, () => false)) return hash
    await mkdir(dirname(path), { recursive: true })
    // Write then rename, so a crash never leaves a half-written blob under its hash
    const temp = `${path}.${randomUUID()}.tmp`
    await writeFile(temp, data)
    await rename(temp, path)
    return hash
  }

  async get(hash: string): Promise<Uint8Array | null> {
    if (!HASH.test(hash)) return null
    return readFile(this.#path(hash)).catch(() => null)
  }

  async open(hash: string): Promise<BlobHandle | null> {
    if (!HASH.test(hash)) return null
    const path = this.#path(hash)
    const info = await stat(path).catch(() => null)
    if (!info) return null
    return { size: info.size, stream: (start = 0, end = info.size - 1) => ReadableStream.from(fileChunks(path, start, end)) }
  }
}

export class MemoryBlobStore implements BlobStore {
  #blobs = new Map<string, Uint8Array>()

  // How many distinct blobs are stored, for tests
  get size(): number {
    return this.#blobs.size
  }

  async put(data: Uint8Array): Promise<string> {
    const hash = createHash('sha256').update(data).digest('hex')
    this.#blobs.set(hash, data)
    return hash
  }

  async get(hash: string): Promise<Uint8Array | null> {
    return this.#blobs.get(hash) ?? null
  }

  async open(hash: string): Promise<BlobHandle | null> {
    const data = this.#blobs.get(hash)
    if (!data) return null
    return { size: data.byteLength, stream: (start = 0, end = data.byteLength - 1) => ReadableStream.from([data.subarray(start, end + 1)]) }
  }
}
