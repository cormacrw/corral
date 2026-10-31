import {
  RUNNER_HEARTBEAT_MS,
  serverMessageSchema,
  protocolMessageType,
  RUNNER_PATH,
  RUNNER_PROTOCOL_VERSION,
  TASK_INTEGRATION_PROTOCOL,
  type RunnerCapacity,
  type RunnerMessage,
  type ServerMessage
} from '@corral/contracts'
import WebSocket from 'ws'
import type { UpdateStatus } from './update-status.ts'

export interface ConnectionHandlers {
  // Includes runs still flushing their terminal report.
  activeRunCount?(): number
  activeRuns(): { runId: string, leaseEpoch: number }[]
  // Read on every connect, so a CLI signed in since then is advertised
  capacity(): Promise<RunnerCapacity>
  onMessage(message: ServerMessage): void
  onStatus(status: 'connected' | 'disconnected', detail?: string): void
}

const MAX_BACKOFF_MS = 30_000

// The runner's outbound connection to the server. Reconnects with backoff
// forever; heartbeats run on their own timer so agent work can't delay them
// (architecture.md, runner rule 1).
export class ServerConnection {
  #token: string | undefined
  #url: string
  #identity: { runnerId: string, name: string }
  #handlers: ConnectionHandlers
  #socket: WebSocket | null = null
  #heartbeat: NodeJS.Timeout | null = null
  #lastUpdateSent = ''
  #updatePoll: NodeJS.Timeout | null = null
  #retry: NodeJS.Timeout | null = null
  #backoff = 1000
  #closed = false

  readonly updateStatus: UpdateStatus | undefined

  constructor(serverUrl: URL, identity: { runnerId: string, name: string }, handlers: ConnectionHandlers, token?: string, updateStatus?: UpdateStatus) {
    this.updateStatus = updateStatus
    this.#token = token
    const url = new URL(RUNNER_PATH, serverUrl)
    url.protocol = url.protocol === 'https:' ? 'wss:' : 'ws:'
    this.#url = url.href
    this.#identity = identity
    this.#handlers = handlers
  }

  get connected(): boolean {
    return this.#socket?.readyState === WebSocket.OPEN
  }

  start(): void {
    this.#closed = false
    this.refreshUpdateStatus()
    this.#open()
    this.#updatePoll = setInterval(() => {
      this.refreshUpdateStatus()
      const state = this.updateStatus
      if (!state || !this.connected) return
      const message: RunnerMessage = { type: 'runner.update-status', draining: state.draining, updateRequested: state.updateRequested, activeRunCount: this.#handlers.activeRunCount?.() ?? this.#handlers.activeRuns().length, updateState: state.updateState, updateError: state.updateError }
      const json = JSON.stringify(message)
      if (json !== this.#lastUpdateSent && this.send(message)) this.#lastUpdateSent = json
    }, 1000)
  }

  refreshUpdateStatus(): void {
    this.updateStatus?.write(this.#handlers.activeRunCount?.() ?? this.#handlers.activeRuns().length)
  }

  send(message: RunnerMessage): boolean {
    this.refreshUpdateStatus()
    if (!this.connected) return false
    this.#socket!.send(JSON.stringify(message))
    return true
  }

  close(): void {
    this.#closed = true
    if (this.#updatePoll) clearInterval(this.#updatePoll)
    if (this.#retry) clearTimeout(this.#retry)
    this.#stopHeartbeat()
    this.#socket?.close()
  }

  #open(): void {
    const socket = new WebSocket(this.#url, { headers: this.#token ? { authorization: `Bearer ${this.#token}` } : {} })
    this.#socket = socket

    socket.on('open', async () => {
      this.#backoff = 1000
      this.#lastUpdateSent = ''
      const capacity = await this.#handlers.capacity()
      if (this.#socket !== socket) return
      this.send({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, taskIntegrationProtocols: [TASK_INTEGRATION_PROTOCOL], taskIntegrationExecutor: true, commit: this.updateStatus?.commit || process.env.CORRAL_BUILD_SHA || 'development', draining: this.updateStatus?.draining ?? false, updateRequested: this.updateStatus?.updateRequested ?? false, autoUpdate: this.updateStatus?.autoUpdate ?? false, updateTarget: this.updateStatus?.serverCommit ?? '', updateState: this.updateStatus?.updateState ?? '', updateError: this.updateStatus?.updateError ?? '', ...this.#identity, ...capacity, activeRuns: this.#handlers.activeRuns() })
      this.#heartbeat = setInterval(() => {
        this.send({ type: 'heartbeat', sentAt: Date.now(), activeRuns: this.#handlers.activeRuns() })
        // Keeps proxies from dropping an idle socket (D12)
        socket.ping()
      }, RUNNER_HEARTBEAT_MS)
    })
    socket.on('message', (data) => {
      let decoded: unknown
      try {
        decoded = JSON.parse(String(data))
      } catch {
        console.warn('Runner protocol error (server → runner, <invalid JSON>): Invalid JSON syntax')
        return
      }
      const parsed = serverMessageSchema.safeParse(decoded)
      if (!parsed.success) {
        console.warn(`Runner protocol error (server → runner, ${protocolMessageType(decoded)}): ${parsed.error.message}`)
        return
      }
      const message = parsed.data
      if (message.type === 'welcome') {
        if (message.integrationCompatibilityReason) console.warn(message.integrationCompatibilityReason)
        this.updateStatus?.server(message.commit)
        if (message.draining) this.updateStatus?.drain(message.updateRequested)
        if (this.updateStatus?.draining) this.send({ type: 'runner.draining', updateRequested: this.updateStatus.updateRequested })
        this.#handlers.onStatus('connected')
      }
      if (message.type === 'runner.drain') this.updateStatus?.drain(message.updateRequested)
      this.#handlers.onMessage(message)
      this.refreshUpdateStatus()
    })
    socket.on('close', (code, reason) => {
      this.#stopHeartbeat()
      if (code === 4000) {
        try {
          const detail = JSON.parse(reason.toString()) as { commit?: string }
          if (typeof detail.commit === 'string') this.updateStatus?.server(detail.commit)
        } catch { /* Older servers may only send a readable protocol error. */ }
      }
      this.refreshUpdateStatus()
      if (this.#socket === socket) this.#socket = null
      this.#handlers.onStatus('disconnected', reason.toString() || `code ${code}`)
      this.#scheduleReconnect()
    })
    // 'close' follows every 'error'; reconnecting happens there
    socket.on('error', () => {})
  }

  #scheduleReconnect(): void {
    if (this.#closed) return
    this.#retry = setTimeout(() => this.#open(), this.#backoff)
    this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF_MS)
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = null
  }
}
