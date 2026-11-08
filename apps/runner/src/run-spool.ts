import { createWriteStream, type WriteStream } from 'node:fs'
import { rm } from 'node:fs/promises'

// A run's raw agent output on disk for the run's length (spool/<runId>.jsonl).
// The transcript the server keeps is built from run.events, so this copy
// stopping costs nothing but itself.
export class RunSpool {
  readonly path: string
  #stream: WriteStream | null
  // A stream still opening would recreate the file after it's deleted
  #closed: Promise<void> = Promise.resolve()

  // onError hears why the copy stopped
  constructor(path: string, onError: (message: string) => void) {
    this.path = path
    const stream = createWriteStream(path, { flags: 'a' })
    // An 'error' with no listener would take down every run on this runner
    stream.on('error', (error) => {
      console.warn(`Could not write to ${path}: ${error.message}`)
      if (this.#stream !== stream) return
      this.#stream = null
      onError(error.message)
    })
    this.#stream = stream
  }

  write(line: string): void {
    this.#stream?.write(line + '\n')
  }

  close(): void {
    const stream = this.#stream
    this.#stream = null
    if (stream) {
      this.#closed = new Promise((resolve) => {
        stream.once('close', () => resolve())
        stream.end()
      })
    }
  }

  async remove(): Promise<void> {
    await this.#closed
    await rm(this.path, { force: true })
  }
}
