import type { RunEvent } from '@corral/contracts'
import { appendFile, mkdir, readFile, rm } from 'node:fs/promises'
import { join } from 'node:path'
import type { BlobStore } from './blob-store.ts'

// Run transcripts: appended to a spool file while the run is live, then
// stored as one immutable blob when it ends. Transcripts never go in the
// database (D8).
export class Transcripts {
  #dir: string
  #blobs: BlobStore

  constructor(dir: string, blobs: BlobStore) {
    this.#dir = dir
    this.#blobs = blobs
  }

  #path(runId: string): string {
    return join(this.#dir, `${runId}.jsonl`)
  }

  async append(runId: string, events: RunEvent[]): Promise<void> {
    if (events.length === 0) return
    await mkdir(this.#dir, { recursive: true })
    await appendFile(this.#path(runId), events.map(e => JSON.stringify(e)).join('\n') + '\n')
  }

  // Moves the spool into the blob store; returns the blob hash, or null if
  // the run produced no events
  async finish(runId: string): Promise<string | null> {
    const data = await readFile(this.#path(runId)).catch(() => null)
    if (!data) return null
    const hash = await this.#blobs.put(data)
    await rm(this.#path(runId), { force: true })
    return hash
  }

  // The live spool, or the stored blob once the run has finished
  async read(runId: string, blob: string | null): Promise<RunEvent[]> {
    const data = blob ? await this.#blobs.get(blob) : await readFile(this.#path(runId)).catch(() => null)
    if (!data) return []
    return new TextDecoder().decode(data).split('\n').filter(Boolean).map(line => JSON.parse(line) as RunEvent)
  }
}
