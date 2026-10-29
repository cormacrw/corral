import {
  RUNNER_HEARTBEAT_MS,
  RUNNER_PATH,
  RUNNER_PROTOCOL_VERSION,
  type RunnerMessage,
  type ServerMessage
} from '@corral/contracts'
import WebSocket from 'ws'

export interface ConnectionHandlers {
  activeRuns(): { runId: string, leaseEpoch: number }[]
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
  #retry: NodeJS.Timeout | null = null
  #backoff = 1000
  #closed = false

  constructor(serverUrl: URL, identity: { runnerId: string, name: string }, handlers: ConnectionHandlers, token?: string) {
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
    this.#open()
  }

  send(message: RunnerMessage): boolean {
    if (!this.connected) return false
    this.#socket!.send(JSON.stringify(message))
    return true
  }

  close(): void {
    this.#closed = true
    if (this.#retry) clearTimeout(this.#retry)
    this.#stopHeartbeat()
    this.#socket?.close()
  }

  #open(): void {
    const socket = new WebSocket(this.#url, { headers: this.#token ? { authorization: `Bearer ${this.#token}` } : {} })
    this.#socket = socket

    socket.on('open', () => {
      this.#backoff = 1000
      this.send({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, ...this.#identity, activeRuns: this.#handlers.activeRuns() })
      this.#heartbeat = setInterval(() => {
        this.send({ type: 'heartbeat', activeRuns: this.#handlers.activeRuns() })
        // Keeps proxies from dropping an idle socket (D12)
        socket.ping()
      }, RUNNER_HEARTBEAT_MS)
    })
    socket.on('message', (data) => {
      let message: ServerMessage
      try {
        message = JSON.parse(String(data)) as ServerMessage
      } catch {
        return
      }
      if (message.type === 'welcome') this.#handlers.onStatus('connected')
      this.#handlers.onMessage(message)
    })
    socket.on('close', (code, reason) => {
      this.#stopHeartbeat()
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
