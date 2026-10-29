import {
  RUNNER_HEARTBEAT_MS,
  RUNNER_PROTOCOL_VERSION,
  type RunnerMessage,
  type RunnerStatus,
  type ServerMessage,
  type SetupJob,
  type SetupJobResult
} from '@corral/contracts'
import { randomUUID } from 'node:crypto'
import { ApiFailure } from './errors.ts'
import type { EventBus } from './events.ts'

export interface RunnerSocket {
  send(data: string): void
  close(code?: number, reason?: string): void
}

type ActiveRuns = { runId: string, leaseEpoch: number }[]

// What the orchestrator does with run traffic. Set once at startup.
export interface RunnerHandlers {
  onConnected(activeRuns: ActiveRuns): Promise<void>
  onHeartbeat(activeRuns: ActiveRuns): Promise<void>
  onDisconnected(): Promise<void>
  onRunMessage(message: Extract<RunnerMessage, { type: 'run.started' | 'run.events' | 'run.ended' }>): Promise<void>
  // Returns the tool result, or throws to send an error back to the agent
  onToolCall(message: Extract<RunnerMessage, { type: 'tool.call' }>): Promise<unknown>
}

const JOB_TIMEOUT_MS = 60_000

// The server's side of the runner WebSocket. The POC has one runner (D1); a
// second connection replaces the first. Pairing and auth come with hosting.
export class RunnerHub {
  #socket: RunnerSocket | null = null
  #status: RunnerStatus = { online: false, runnerId: null, name: null, connectedAt: null, lastHeartbeatAt: null }
  #pending = new Map<string, { resolve: (r: SetupJobResult) => void, reject: (e: Error) => void, timer: NodeJS.Timeout }>()
  #handlers: RunnerHandlers | null = null
  #events: EventBus
  // Run messages are handled in order per run, so the last events batch is
  // on disk before run.ended reads the transcript. Tool calls and job
  // results stay unqueued: a tool call may wait on a job over this socket.
  #queues = new Map<string, Promise<void>>()

  constructor(events: EventBus) {
    this.#events = events
  }

  setHandlers(handlers: RunnerHandlers): void {
    this.#handlers = handlers
  }

  status(): RunnerStatus {
    return { ...this.#status }
  }

  get online(): boolean {
    return this.#status.online
  }

  // Called by the WebSocket route for each new connection
  connect(socket: RunnerSocket) {
    let hello = false
    return {
      onMessage: async (raw: string) => {
        let message: RunnerMessage
        try {
          message = JSON.parse(raw) as RunnerMessage
        } catch {
          return
        }
        if (message.type === 'hello') {
          if (message.protocol !== RUNNER_PROTOCOL_VERSION) {
            socket.close(4000, `Protocol ${message.protocol} not supported; server speaks ${RUNNER_PROTOCOL_VERSION}`)
            return
          }
          hello = true
          if (this.#socket && this.#socket !== socket) this.#socket.close(4001, 'Replaced by a newer runner connection')
          this.#socket = socket
          const now = new Date().toISOString()
          this.#setStatus({ online: true, runnerId: message.runnerId, name: message.name, connectedAt: now, lastHeartbeatAt: now })
          this.send({ type: 'welcome', runnerId: message.runnerId })
          await this.#handlers?.onConnected(message.activeRuns).catch(error => console.error('Runner reconciliation failed', error))
          return
        }
        if (!hello || this.#socket !== socket) return
        // One bad message must not take the connection or the process down
        await this.#handle(message).catch(error => console.error(`Runner message ${message.type} failed`, error))
      },
      onClose: async () => {
        if (this.#socket !== socket) return
        this.#socket = null
        for (const [jobId, pending] of this.#pending) {
          clearTimeout(pending.timer)
          pending.reject(new Error('Runner disconnected'))
          this.#pending.delete(jobId)
        }
        this.#setStatus({ ...this.#status, online: false })
        await this.#handlers?.onDisconnected()
      }
    }
  }

  // Server shutdown: the runner reconnects on its own with backoff
  disconnect(): void {
    this.#socket?.close(1001, 'Server shutting down')
    this.#socket = null
  }

  send(message: ServerMessage): boolean {
    if (!this.#socket) return false
    this.#socket.send(JSON.stringify(message))
    return true
  }

  // Sends a setup job and waits for its result. Throws an API failure when
  // the runner is offline, so routes report it plainly.
  request<K extends SetupJob['kind']>(job: Extract<SetupJob, { kind: K }>, timeoutMs = JOB_TIMEOUT_MS): Promise<Extract<SetupJobResult, { kind: K }>> {
    if (!this.#socket) return Promise.reject(runnerOffline())
    const jobId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(jobId)
        reject(new Error(`Runner job ${job.kind} timed out`))
      }, timeoutMs)
      this.#pending.set(jobId, { resolve: resolve as (r: SetupJobResult) => void, reject, timer })
      this.send({ type: 'job.request', jobId, job })
    })
  }

  async #handle(message: RunnerMessage): Promise<void> {
    switch (message.type) {
      case 'heartbeat':
        this.#setStatus({ ...this.#status, lastHeartbeatAt: new Date().toISOString() }, false)
        await this.#handlers?.onHeartbeat(message.activeRuns)
        return
      case 'job.result': {
        const pending = this.#pending.get(message.jobId)
        if (!pending) return
        clearTimeout(pending.timer)
        this.#pending.delete(message.jobId)
        if (message.ok) pending.resolve(message.result)
        else pending.reject(new Error(message.error))
        return
      }
      case 'run.started':
      case 'run.events':
      case 'run.ended': {
        const previous = this.#queues.get(message.runId) ?? Promise.resolve()
        const next = previous.then(() => this.#handlers?.onRunMessage(message)).catch(error => console.error(`Runner message ${message.type} failed`, error))
        this.#queues.set(message.runId, next)
        await next
        if (message.type === 'run.ended') this.#queues.delete(message.runId)
        return
      }
      case 'tool.call': {
        if (!this.#handlers) return
        try {
          const result = await this.#handlers.onToolCall(message)
          this.send({ type: 'tool.result', callId: message.callId, ok: true, result })
        } catch (error) {
          this.send({ type: 'tool.result', callId: message.callId, ok: false, error: error instanceof Error ? error.message : String(error) })
        }
        return
      }
      // Nobody sends run.message yet; when the API does, it answers with this
      case 'run.message.rejected':
        console.warn(`Run ${message.runId} did not take a message: ${message.error}`)
        return
      case 'hello':
        return
    }
  }

  #setStatus(status: RunnerStatus, publish = true): void {
    this.#status = status
    if (publish) this.#events.publish({ type: 'runner.status', status: this.status() })
  }
}

export function runnerOffline(): ApiFailure {
  return new ApiFailure(503, { code: 'runner_offline' })
}

// How long without a heartbeat before the server treats the runner as gone,
// even if the socket hasn't closed (e.g. a sleeping laptop)
export const RUNNER_STALE_MS = RUNNER_HEARTBEAT_MS * 3
