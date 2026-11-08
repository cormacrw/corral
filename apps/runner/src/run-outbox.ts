import type { RunEvent, RunJob, RunnerMessage } from '@corral/contracts'
import { batchEvents, capEvent } from './event-limits.ts'

// What runs need from the server connection
export interface RunConnection {
  // Open and hello'd: a message sent now reaches the server's handlers
  readonly connected: boolean
  send(message: RunnerMessage): boolean
  // The run count changed
  refreshUpdateStatus(): Promise<void>
}

const EVENT_BATCH_MS = 500
// What a run may hold for a server that's out of reach. Past this the oldest
// transcript events go, with a note saying so; run.started and run.ended stay.
const OUTBOX_MAX_BYTES = 16 * 1024 * 1024

type RunTraffic = Extract<RunnerMessage, { type: 'run.started' | 'run.events' | 'run.ended' }>

interface Outgoing {
  message: RunTraffic
  bytes: number
}

// Everything a run tells the server, in order. Events are batched; traffic the
// connection can't take yet waits here, and the run stays in hello until
// run.ended has gone out. There's no ack: once the socket takes a message it
// counts as sent, so a message lost in a half-dead socket stays lost. A replay
// after a reconnect only repeats what never reached a socket.
export class RunOutbox {
  #connection: RunConnection
  #job: Pick<RunJob, 'runId' | 'leaseEpoch'>
  // Called once run.ended has gone out
  #onEnded: () => void
  #events: RunEvent[] = []
  #flushTimer: NodeJS.Timeout | null = null
  #waiting: Outgoing[] = []
  #bytes = 0
  // The note standing in for events that had to be dropped, and how many
  #dropNote: Outgoing | null = null
  #dropped = 0
  // No more transcript events once the run has ended
  #closed = false

  constructor(connection: RunConnection, job: Pick<RunJob, 'runId' | 'leaseEpoch'>, onEnded: () => void) {
    this.#connection = connection
    this.#job = job
    this.#onEnded = onEnded
  }

  // Queued for the next batch
  events(events: RunEvent[]): void {
    if (events.length === 0 || this.#closed) return
    for (const event of events) this.#events.push(capEvent(event))
    this.#flushTimer ??= setTimeout(() => this.flush(), EVENT_BATCH_MS)
  }

  note(text: string): void {
    this.events([{ type: 'system', text }])
  }

  flush(): void {
    if (this.#flushTimer) clearTimeout(this.#flushTimer)
    this.#flushTimer = null
    if (this.#events.length === 0) return
    const events = this.#events
    this.#events = []
    for (const batch of batchEvents(events)) this.post({ type: 'run.events', runId: this.#job.runId, leaseEpoch: this.#job.leaseEpoch, events: batch })
  }

  // Flushes what's queued; later events are dropped
  close(): void {
    this.flush()
    this.#closed = true
  }

  post(message: RunTraffic): void {
    if (this.#waiting.length === 0 && this.#connection.send(message)) {
      if (message.type === 'run.ended') this.#onEnded()
      return
    }
    const bytes = JSON.stringify(message).length
    this.#waiting.push({ message, bytes })
    this.#bytes += bytes
    this.#trim()
  }

  // Sends what waited, once the server has welcomed this runner again
  drain(): void {
    for (let next = this.#waiting[0]; next; next = this.#waiting[0]) {
      if (!this.#connection.send(next.message)) return
      this.#waiting.shift()
      this.#bytes -= next.bytes
      if (next === this.#dropNote) {
        this.#dropNote = null
        this.#dropped = 0
      }
      if (next.message.type === 'run.ended') this.#onEnded()
    }
  }

  // The newest events are the ones to keep: they hold how the run ended, and a
  // PM turn's reply is its last message
  #trim(): void {
    while (this.#bytes > OUTBOX_MAX_BYTES) {
      const index = this.#waiting.findIndex(o => o.message.type === 'run.events' && o !== this.#dropNote)
      if (index < 0) break
      const [oldest] = this.#waiting.splice(index, 1) as [Outgoing]
      this.#bytes -= oldest.bytes
      this.#dropped += oldest.message.type === 'run.events' ? oldest.message.events.length : 0
      if (!this.#dropNote) {
        this.#dropNote = { message: { type: 'run.events', runId: this.#job.runId, leaseEpoch: this.#job.leaseEpoch, events: [] }, bytes: 0 }
        this.#waiting.splice(index, 0, this.#dropNote)
      }
    }
    if (this.#dropNote?.message.type === 'run.events') {
      this.#dropNote.message.events = [{ type: 'system', text: `${this.#dropped} transcript events were dropped here: the server was out of reach for too long` }]
    }
  }
}
