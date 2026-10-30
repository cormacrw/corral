import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Atomic replacement lets a host updater read this without a port or a partial JSON file.
// State survives socket reconnects, but a new process starts clear after an update.
export class UpdateStatus {
  #lastWritten: string | undefined
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

  write(activeRunCount: number): void {
    try {
      const raw = readFileSync(join(this.dataDir, 'updater-result.json'), 'utf8')
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
    const path = join(this.dataDir, 'update-status.json')
    const json = JSON.stringify({
      updateState: this.updateState,
      updateError: this.updateError,
      commit: this.commit,
      serverCommit: this.serverCommit,
      behind: this.behind,
      draining: this.draining,
      updateRequested: this.updateRequested,
      activeRunCount,
      idle: activeRunCount === 0
    }, null, 2) + '\n'
    if (json === this.#lastWritten) return
    writeFileSync(`${path}.tmp`, json)
    renameSync(`${path}.tmp`, path)
    this.#lastWritten = json
  }
}
