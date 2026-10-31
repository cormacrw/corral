import { mkdirSync } from 'node:fs'
import { readFile, rename, writeFile } from 'node:fs/promises'
import { join } from 'node:path'

// Atomic replacement lets a host updater read this without a port or a partial JSON file.
// State survives socket reconnects, but a new process starts clear after an update.
// The file shares a disk with installs and builds, so nothing here runs on the
// event loop's main path (runner rule 1), and a disk error only costs a write.
export class UpdateStatus {
  #lastWritten: string | undefined
  #activeRunCount = 0
  #writing: Promise<void> | null = null
  #writeFailed = false
  serverCommit: string | null = null
  updateState = ''
  updateError = ''
  #feedback = ''
  draining = false
  updateRequested = false

  readonly dataDir: string
  readonly commit: string
  readonly autoUpdate: boolean

  constructor(dataDir: string, commit: string, autoUpdate: boolean) {
    this.dataDir = dataDir
    this.commit = commit
    this.autoUpdate = autoUpdate
    mkdirSync(dataDir, { recursive: true })
  }

  get behind(): boolean {
    return this.serverCommit !== null && this.commit !== this.serverCommit
  }

  server(commit: string): void {
    if (commit !== this.serverCommit) {
      this.updateState = ''
      this.updateError = ''
    }
    this.serverCommit = commit
    if (this.behind && this.autoUpdate && this.updateState !== 'failed') this.draining = true
  }

  drain(updateRequested: boolean): void {
    this.updateState = ''
    this.updateError = ''
    this.draining = true
    this.updateRequested ||= updateRequested
  }

  // Reads the host updater's feedback, then writes the status
  async refresh(activeRunCount: number): Promise<void> {
    try {
      const raw = await readFile(join(this.dataDir, 'updater-result.json'), 'utf8')
      if (raw !== this.#feedback && this.serverCommit !== null) {
        this.#feedback = raw
        const result = JSON.parse(raw) as { target: string, state: string, error: string }
        if (result.target === this.serverCommit && this.behind) {
          this.updateState = result.state
          this.updateError = result.error
          if (result.state === 'failed') {
            this.draining = false
            this.updateRequested = false
          }
        }
      }
    } catch { /* No host feedback yet. */ }
    return this.write(activeRunCount)
  }

  // Cheap when nothing changed, so it can follow every message. Writes never
  // overlap, and the last state asked for is the one that lands. Never rejects.
  write(activeRunCount: number): Promise<void> {
    this.#activeRunCount = activeRunCount
    this.#writing ??= this.#flush().finally(() => {
      this.#writing = null
    })
    return this.#writing
  }

  async #flush(): Promise<void> {
    const path = join(this.dataDir, 'update-status.json')
    for (let json = this.#json(); json !== this.#lastWritten; json = this.#json()) {
      try {
        await writeFile(`${path}.tmp`, json)
        await rename(`${path}.tmp`, path)
        this.#lastWritten = json
        this.#writeFailed = false
      } catch (error) {
        // The next poll tries again; once is enough to say so
        if (!this.#writeFailed) console.warn(`Could not write update-status.json: ${error instanceof Error ? error.message : String(error)}`)
        this.#writeFailed = true
        return
      }
    }
  }

  #json(): string {
    return JSON.stringify({
      updateState: this.updateState,
      updateError: this.updateError,
      commit: this.commit,
      serverCommit: this.serverCommit,
      behind: this.behind,
      draining: this.draining,
      updateRequested: this.updateRequested,
      activeRunCount: this.#activeRunCount,
      idle: this.#activeRunCount === 0
    }, null, 2) + '\n'
  }
}
