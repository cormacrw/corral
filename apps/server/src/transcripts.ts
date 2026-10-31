import type { RunEvent } from '@corral/contracts'
import { appendFile, mkdir, readdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BlobStore } from './blob-store.ts'

const SPOOL_SUFFIX = '.jsonl'

// Run transcripts: appended to a spool file while the run is live, then
// stored as one immutable blob when it ends. Transcripts never go in the
// database (D8).
export class Transcripts {
  #dir: string
  #blobs: BlobStore
  // Each live run's line count. Appends to a run wait for each other, so every
  // one knows where its lines land.
  #lengths = new Map<string, Promise<number>>()

  constructor(dir: string, blobs: BlobStore) {
    this.#dir = dir
    this.#blobs = blobs
  }

  #path(runId: string): string {
    return join(this.#dir, `${runId}${SPOOL_SUFFIX}`)
  }

  // After a restart the spool is the only record of how long it is
  async #spooledLines(runId: string): Promise<number> {
    const data = await readFile(this.#path(runId), 'utf8').catch(() => '')
    return data.split('\n').length - 1
  }

  // Returns where the first event landed in the transcript
  append(runId: string, events: RunEvent[]): Promise<number> {
    const length = this.#lengths.get(runId) ?? this.#spooledLines(runId)
    if (events.length === 0) return length
    const written = length.then(async (offset) => {
      await mkdir(this.#dir, { recursive: true })
      await appendFile(this.#path(runId), events.map(e => JSON.stringify(e)).join('\n') + '\n')
      return offset
    })
    this.#lengths.set(runId, written.then(offset => offset + events.length, () => length))
    return written
  }

  // Moves the spool into the blob store; returns the blob hash, or null if
  // the run produced no events
  async finish(runId: string): Promise<string | null> {
    this.#lengths.delete(runId)
    const data = await readFile(this.#path(runId)).catch(() => null)
    if (!data) return null
    const hash = await this.#blobs.put(data)
    await rm(this.#path(runId), { force: true })
    return hash
  }

  // The runs with a spool file
  async spooled(): Promise<string[]> {
    const files = await readdir(this.#dir).catch(() => [])
    return files.filter(f => f.endsWith(SPOOL_SUFFIX)).map(f => f.slice(0, -SPOOL_SUFFIX.length))
  }

  // For a spool whose run no longer exists
  async discard(runId: string): Promise<void> {
    this.#lengths.delete(runId)
    await rm(this.#path(runId), { force: true })
  }

  // The live spool, or the stored blob once the run has finished
  async read(runId: string, blob: string | null): Promise<RunEvent[]> {
    const data = blob ? await this.#blobs.get(blob) : await readFile(this.#path(runId)).catch(() => null)
    if (!data) return []
    return new TextDecoder().decode(data).split('\n').filter(Boolean).map(line => JSON.parse(line) as RunEvent)
  }
}
