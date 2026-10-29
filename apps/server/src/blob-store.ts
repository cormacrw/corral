import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readFile, rename, stat, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'

// Immutable, content-addressed files: evidence and run transcripts (D8).
// Local folder now, S3-compatible later under the same keys (D1).
export interface BlobStore {
  // Returns the sha256; storing the same bytes twice is a no-op
  put(data: Uint8Array): Promise<string>
  get(hash: string): Promise<Uint8Array | null>
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
}
