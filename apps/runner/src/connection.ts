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

const MIN_BACKOFF_MS = 1000
const MAX_BACKOFF_MS = 30_000
// The soonest to retry after a refusal that won't change right away: the
// protocol (4000), a newer connection with this ID (4001) or the token (4003)
const REFUSED_DELAY_MS = 15_000
const REFUSED_CODES = new Set([4000, 4001, 4003])
const HANDSHAKE_TIMEOUT_MS = 15_000
// Heartbeats in a row with nothing back before the socket counts as dead. Two,
// so a busy server isn't mistaken for a lost one.
const MISSED_HEARTBEATS_LIMIT = 2
// The run manager replays these after welcome, so nothing newer may overtake them
const RUN_TRAFFIC = new Set<RunnerMessage['type']>(['run.started', 'run.events', 'run.ended'])

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
  #polling = false
  #retry: NodeJS.Timeout | null = null
  #backoff = MIN_BACKOFF_MS
  #closed = false
  // The server drops anything that comes before this socket's hello
  #helloSent = false
  #welcomed = false

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

  // Open and hello'd: a message sent now reaches the server's handlers
  get connected(): boolean {
    return this.#helloSent && this.#socket?.readyState === WebSocket.OPEN
  }

  start(): void {
    this.#closed = false
    void this.#pollUpdateStatus()
    this.#open()
    this.#updatePoll = setInterval(() => void this.#pollUpdateStatus(), 1000)
  }

  async #pollUpdateStatus(): Promise<void> {
    // A stalled disk mustn't stack up polls
    if (this.#polling) return
    this.#polling = true
    try {
      await this.updateStatus?.refresh(this.#activeRunCount())
    } finally {
      this.#polling = false
    }
    const state = this.updateStatus
    if (!state || !this.connected) return
    const message: RunnerMessage = { type: 'runner.update-status', draining: state.draining, updateRequested: state.updateRequested, activeRunCount: this.#activeRunCount(), updateState: state.updateState, updateError: state.updateError }
    const json = JSON.stringify(message)
    if (json !== this.#lastUpdateSent && this.send(message)) this.#lastUpdateSent = json
  }

  #activeRunCount(): number {
    return this.#handlers.activeRunCount?.() ?? this.#handlers.activeRuns().length
  }

  // Writes the status file if it changed; the 1 s poll reads the updater's answer
  refreshUpdateStatus(): Promise<void> {
    return this.updateStatus?.write(this.#activeRunCount()) ?? Promise.resolve()
  }

  send(message: RunnerMessage): boolean {
    void this.refreshUpdateStatus()
    if (!this.connected || (!this.#welcomed && RUN_TRAFFIC.has(message.type))) return false
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
    const socket = new WebSocket(this.#url, { handshakeTimeout: HANDSHAKE_TIMEOUT_MS, headers: this.#token ? { authorization: `Bearer ${this.#token}` } : {} })
    this.#socket = socket
    this.#helloSent = false
    this.#welcomed = false
    const liveness = { answered: true, missed: 0 }

    socket.on('open', () => void this.#hello(socket, liveness))
    socket.on('pong', () => {
      liveness.answered = true
    })
    socket.on('message', (data) => {
      liveness.answered = true
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
        // Only now has the server taken this runner: a socket that opens and is
        // refused has to keep backing off
        this.#backoff = MIN_BACKOFF_MS
        this.#welcomed = true
        this.updateStatus?.server(message.commit)
        if (message.draining) this.updateStatus?.drain(message.updateRequested)
        if (this.updateStatus?.draining) this.send({ type: 'runner.draining', updateRequested: this.updateStatus.updateRequested })
        this.#handlers.onStatus('connected')
      }
      if (message.type === 'runner.drain') this.updateStatus?.drain(message.updateRequested)
      this.#handlers.onMessage(message)
      void this.refreshUpdateStatus()
    })
    socket.on('close', (code, reason) => {
      this.#stopHeartbeat()
      if (code === 4000) {
        try {
          const detail = JSON.parse(reason.toString()) as { commit?: string }
          if (typeof detail.commit === 'string') this.updateStatus?.server(detail.commit)
        } catch { /* Older servers may only send a readable protocol error. */ }
      }
      void this.refreshUpdateStatus()
      if (this.#socket === socket) this.#socket = null
      this.#handlers.onStatus('disconnected', reason.toString() || `code ${code}`)
      this.#scheduleReconnect(code)
    })
    // 'close' follows every 'error'; reconnecting happens there
    socket.on('error', () => {})
  }

  async #hello(socket: WebSocket, liveness: { answered: boolean, missed: number }): Promise<void> {
    this.#lastUpdateSent = ''
    let capacity: RunnerCapacity
    try {
      capacity = await this.#handlers.capacity()
    } catch (error) {
      console.warn(`Could not read this runner's capacity: ${error instanceof Error ? error.message : String(error)}`)
      socket.terminate()
      return
    }
    // That took seconds, and the socket may have gone meanwhile
    if (this.#socket !== socket || socket.readyState !== WebSocket.OPEN) return
    socket.send(JSON.stringify({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, taskIntegrationProtocols: [TASK_INTEGRATION_PROTOCOL], taskIntegrationExecutor: true, epicRebaseExecutor: true, commit: this.updateStatus?.commit || process.env.CORRAL_BUILD_SHA || 'development', draining: this.updateStatus?.draining ?? false, updateRequested: this.updateStatus?.updateRequested ?? false, autoUpdate: this.updateStatus?.autoUpdate ?? false, updateTarget: this.updateStatus?.serverCommit ?? '', updateState: this.updateStatus?.updateState ?? '', updateError: this.updateStatus?.updateError ?? '', ...this.#identity, ...capacity, activeRuns: this.#handlers.activeRuns() } satisfies RunnerMessage))
    this.#helloSent = true
    this.#heartbeat = setInterval(() => {
      // A half-open connection stays OPEN until the kernel gives up, so silence
      // is the only sign of it. Anything from the server counts as an answer.
      liveness.missed = liveness.answered ? 0 : liveness.missed + 1
      if (liveness.missed >= MISSED_HEARTBEATS_LIMIT) {
        socket.terminate()
        return
      }
      liveness.answered = false
      this.send({ type: 'heartbeat', sentAt: Date.now(), activeRuns: this.#handlers.activeRuns() })
      // Keeps proxies from dropping an idle socket (D12)
      socket.ping()
    }, RUNNER_HEARTBEAT_MS)
  }

  #scheduleReconnect(code: number): void {
    if (this.#closed) return
    const floor = REFUSED_CODES.has(code) ? REFUSED_DELAY_MS : MIN_BACKOFF_MS / 2
    // Jittered, so runners that lost the same server don't all return at once
    const delay = floor + Math.random() * (Math.max(this.#backoff, floor * 2) - floor)
    this.#retry = setTimeout(() => this.#open(), delay)
    this.#backoff = Math.min(this.#backoff * 2, MAX_BACKOFF_MS)
  }

  #stopHeartbeat(): void {
    if (this.#heartbeat) clearInterval(this.#heartbeat)
    this.#heartbeat = null
  }
}
