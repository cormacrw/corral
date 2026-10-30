import { mkdirSync, renameSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// Atomic replacement lets a host updater read this without a port or a partial JSON file.
// State survives socket reconnects, but a new process starts clear after an update.
export class UpdateStatus {
  #lastWritten: string | undefined
  serverCommit: string | null = null
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
    this.serverCommit = commit
    if (this.behind && this.autoUpdate) this.draining = true
  }

  drain(updateRequested: boolean): void {
    this.draining = true
    this.updateRequested ||= updateRequested
  }

  write(activeRunCount: number): void {
    const path = join(this.dataDir, 'update-status.json')
    const json = JSON.stringify({
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
