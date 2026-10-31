import {
  RUNNER_HEARTBEAT_MS,
  TASK_INTEGRATION_PROTOCOL,
  integrationCompatibilityReason,
  runnerMessageSchema,
  legacyRunnerHelloSchema,
  protocolMessageType,
  RUNNER_PROTOCOL_VERSION,
  RUNNER_ROLES,
  type RunnerCapacity,
  type RunnerInfo,
  type RunnerMessage,
  type RunnerStatus,
  type ServerMessage,
  type SetupJob,
  type SlotSource,
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
  onConnected(activeRuns: ActiveRuns, runnerId: string): Promise<void>
  onReady(): void
  onHeartbeat(activeRuns: ActiveRuns, runnerId: string, sentAt?: number): Promise<void>
  onDisconnected(): Promise<void>
  onRunMessage(message: Extract<RunnerMessage, { type: 'run.started' | 'run.events' | 'run.ended' }>, runnerId: string): Promise<void>
  // Returns the tool result, or throws to send an error back to the agent
  onToolCall(message: Extract<RunnerMessage, { type: 'tool.call' }>, runnerId: string): Promise<unknown>
}

const JOB_TIMEOUT_MS = 60_000

// A setup job lost with its connection, as opposed to one that failed
export class RunnerDisconnected extends Error {
  constructor() {
    super('Runner disconnected')
  }
}

// Connections are independent; only the same runner identity replaces a socket.
export class RunnerHub {
  #runners = new Map<string, { socket: RunnerSocket | null, status: RunnerStatus['runners'][number] }>()
  #pending = new Map<string, { resolve: (r: SetupJobResult) => void, reject: (e: Error) => void, timer: NodeJS.Timeout, runnerId: string }>()
  #cliCache = new Map<string, { result?: Extract<SetupJobResult, { kind: 'detect_clis' }>, detecting?: Promise<Extract<SetupJobResult, { kind: 'detect_clis' }>> }>()
  #handlers: RunnerHandlers | null = null
  #events: EventBus
  // Run messages are handled in order per run, so the last events batch is
  // on disk before run.ended reads the transcript. Tool calls and job
  // results stay unqueued: a tool call may wait on a job over this socket.
  #queues = new Map<string, Promise<void>>()
  // Active runs per runner, as the orchestrator last counted them
  #inUse = new Map<string, number>()

  readonly commit: string

  constructor(events: EventBus, commit = process.env.CORRAL_BUILD_SHA || 'development') {
    this.commit = commit
    this.#events = events
  }

  setHandlers(handlers: RunnerHandlers): void {
    this.#handlers = handlers
  }

  status(): RunnerStatus {
    const runners = [...this.#runners.values()].map(r => ({ ...r.status }))
    const first = runners.find(r => r.online)
    return { online: !!first, runnerId: first?.id ?? null, name: first?.name ?? null, connectedAt: first?.connectedAt ?? null, lastHeartbeatAt: first?.lastHeartbeatAt ?? null, protocol: RUNNER_PROTOCOL_VERSION, runners }
  }

  name(runnerId: string | null): string | null {
    return runnerId ? this.#runners.get(runnerId)?.status.name ?? null : null
  }

  // The orchestrator's count of active runs per runner, after a run changes
  setInUse(counts: Map<string, number>): void {
    this.#inUse = counts
    let changed = false
    for (const [id, runner] of this.#runners) {
      const n = counts.get(id) ?? 0
      if (runner.status.slotsInUse === n) continue
      runner.status.slotsInUse = n
      changed = true
    }
    if (changed) this.#publishStatus()
  }

  get online(): boolean {
    return !!this.pick()
  }

  // Detection is cached per connection and shared by requests during setup.
  detectClis(refresh = false, runnerId = this.pick()): Promise<Extract<SetupJobResult, { kind: 'detect_clis' }>> {
    if (!this.isOnline(runnerId) || !runnerId) return Promise.reject(runnerOffline())
    let cache = this.#cliCache.get(runnerId)
    if (!cache) {
      cache = {}
      this.#cliCache.set(runnerId, cache)
    }
    if (!refresh && cache.result) return Promise.resolve(cache.result)
    if (cache.detecting) return cache.detecting
    const entry = cache
    const detecting = this.#request({ kind: 'detect_clis' }, JOB_TIMEOUT_MS, runnerId).then((result) => {
      entry.result = result
      return result
    }).finally(() => {
      if (entry.detecting === detecting) delete entry.detecting
    })
    entry.detecting = detecting
    return detecting
  }

  // Called by the WebSocket route for each new connection
  connect(socket: RunnerSocket) {
    let runnerId: string | null = null
    return {
      onMessage: async (raw: string) => {
        let decoded: unknown
        try {
          decoded = JSON.parse(raw)
        } catch {
          console.warn('Runner protocol error (runner → server, <invalid JSON>): Invalid JSON syntax')
          return
        }
        const legacyHello = legacyRunnerHelloSchema.safeParse(decoded)
        if (legacyHello.success && legacyHello.data.protocol !== RUNNER_PROTOCOL_VERSION) {
          this.#turnAway(legacyHello.data)
          socket.close(4000, JSON.stringify({ protocol: RUNNER_PROTOCOL_VERSION, commit: this.commit }))
          return
        }
        const parsed = runnerMessageSchema.safeParse(decoded)
        if (!parsed.success) {
          console.warn(`Runner protocol error (runner → server, ${protocolMessageType(decoded)}): ${parsed.error.message}`)
          return
        }
        const message = parsed.data
        if (message.type === 'hello') {
          if (runnerId) return
          runnerId = message.runnerId
          const old = this.#runners.get(runnerId)
          if (old?.socket) {
            this.#rejectJobs(runnerId)
            old.socket.close(4001, 'Replaced by a newer runner connection')
          }
          this.#cliCache.delete(runnerId)
          const now = new Date().toISOString()
          const capacity = parseCapacity(message)
          this.#runners.set(runnerId, { socket, status: { id: runnerId, name: message.name, online: false, slotsInUse: this.#inUse.get(runnerId) ?? 0, protocol: message.protocol, needsUpdate: false, connectedAt: now, lastHeartbeatAt: now, ...capacity, taskIntegrationProtocols: message.taskIntegrationProtocols ?? [], taskIntegrationExecutor: !!message.taskIntegrationExecutor, integrationCompatibilityReason: integrationCompatibilityReason(TASK_INTEGRATION_PROTOCOL, message.taskIntegrationProtocols), commit: message.commit || 'unknown', serverCommit: this.commit, behind: message.commit !== this.commit, draining: !!message.draining || (!!message.autoUpdate && message.commit !== this.commit && !(message.updateState === 'failed' && message.updateTarget === this.commit)), updateRequested: !!message.updateRequested, updateState: message.updateState ?? '', updateError: message.updateError ?? '', activeRunCount: message.activeRuns.length } })
          // Don't dispatch into this socket until its hello snapshot has been
          // reconciled: a newly assigned run isn't in that snapshot.
          await this.#handlers?.onConnected(message.activeRuns, runnerId).catch(error => console.error('Runner reconciliation failed', error))
          const runner = this.#runners.get(runnerId)
          if (runner?.socket !== socket) return
          runner.status.online = true
          this.#publishStatus()
          this.send({ type: 'welcome', ...(runner.status.integrationCompatibilityReason ? { integrationCompatibilityReason: runner.status.integrationCompatibilityReason } : {}), runnerId, commit: this.commit, draining: runner.status.draining, updateRequested: runner.status.updateRequested }, runnerId)
          void this.detectClis(true, runnerId).catch(error => console.error('Runner CLI detection failed', error))
          this.#handlers?.onReady()
          return
        }
        if (!runnerId || this.#runners.get(runnerId)?.socket !== socket) return
        // One bad message must not take the connection or the process down
        await this.#handle(message, runnerId).catch(error => console.error(`Runner message ${message.type} failed`, error))
      },
      onClose: async () => {
        if (!runnerId) return
        const runner = this.#runners.get(runnerId)
        if (runner?.socket !== socket) return
        await this.#disconnected(runnerId, runner)
      }
    }
  }

  async #disconnected(runnerId: string, runner: { socket: RunnerSocket | null, status: RunnerStatus['runners'][number] }): Promise<void> {
    runner.socket = null
    runner.status.online = false
    this.#rejectJobs(runnerId)
    this.#publishStatus()
    await this.#handlers?.onDisconnected()
  }

  // A runner that vanished without a TCP FIN (a sleeping PC, D25) still looks
  // connected until the OS gives up on the socket, and every job and run sent
  // to it is lost in the meantime. If it was only slow, closing makes it
  // reconnect, and its hello reconciles the runs.
  dropSilent(now = Date.now()): void {
    for (const [id, runner] of this.#runners) {
      if (!runner.socket || !runner.status.online || now - Date.parse(runner.status.lastHeartbeatAt) <= RUNNER_STALE_MS) continue
      console.warn(`Runner ${runner.status.name} has sent no heartbeat for ${RUNNER_STALE_MS / 1000} s; dropping it`)
      const { socket } = runner
      void this.#disconnected(id, runner).catch(error => console.error('Runner disconnect failed', error))
      socket.close(4002, 'No heartbeat')
    }
  }

  // A runner on another protocol stays in the list as needing an update,
  // unless the same runner is connected on the right one
  #turnAway(message: Extract<RunnerMessage, { type: 'hello' }>): void {
    if (typeof message.runnerId !== 'string' || !message.runnerId) return
    const old = this.#runners.get(message.runnerId)
    if (old?.socket) return
    const now = new Date().toISOString()
    this.#runners.set(message.runnerId, {
      socket: null,
      status: {
        id: message.runnerId,
        name: typeof message.name === 'string' && message.name ? message.name : message.runnerId,
        online: false,
        slotsInUse: 0,
        protocol: message.protocol,
        needsUpdate: true,
        commit: message.commit || 'unknown',
        serverCommit: this.commit,
        behind: message.commit !== this.commit,
        draining: false,
        updateRequested: false,
        connectedAt: now,
        lastHeartbeatAt: now,
        // An older hello may not carry capacity; keep what it last said
        ...parseCapacity(message, old?.status)
      }
    })
    this.#publishStatus()
  }

  // Server shutdown: the runner reconnects on its own with backoff
  disconnect(): void {
    for (const runner of this.#runners.values()) runner.socket?.close(1001, 'Server shutting down')
  }

  // With a runtime, only a runner that has it signed in
  pick(runtime?: string): string | null {
    return [...this.#runners.entries()].filter(([, r]) => r.socket && r.status.online && (!runtime || r.status.runtimes.includes(runtime))).sort((a, b) => Number(a[1].status.draining) - Number(b[1].status.draining) || a[1].status.connectedAt.localeCompare(b[1].status.connectedAt))[0]?.[0] ?? null
  }

  // Online runners ready for dispatch, longest connected first
  available(): RunnerInfo[] {
    return [...this.#runners.values()].filter(r => r.socket && r.status.online && !r.status.draining).map(r => ({ ...r.status }))
      .sort((a, b) => a.connectedAt.localeCompare(b.connectedAt))
  }

  // The longest-connected runner that can run integration jobs
  integrationRunner(): string | null {
    return this.available().find(r => r.taskIntegrationExecutor)?.id ?? null
  }

  isOnline(runnerId: string | null): boolean {
    return !!runnerId && !!this.#runners.get(runnerId)?.socket && !!this.#runners.get(runnerId)?.status.online
  }

  send(message: ServerMessage, runnerId: string | null): boolean {
    const runner = runnerId ? this.#runners.get(runnerId) : undefined
    if (!runner?.socket) return false
    if (message.type === 'run.assign') {
      if (runner.status.draining) return false
      const required = 'integrationProtocol' in message.job ? message.job.integrationProtocol ?? 0 : 0
      if (integrationCompatibilityReason(required, runner.status.taskIntegrationProtocols)) return false
    }
    runner.socket.send(JSON.stringify(message))
    return true
  }

  drain(runnerId: string, updateRequested = false): RunnerInfo {
    const runner = this.#runners.get(runnerId)
    if (!runner?.socket || !runner.status.online) throw runnerOffline()
    runner.status.draining = true
    runner.status.updateRequested ||= updateRequested
    this.send({ type: 'runner.drain', updateRequested: runner.status.updateRequested }, runnerId)
    this.#publishStatus()
    this.#handlers?.onReady()
    return { ...runner.status }
  }

  #rejectJobs(runnerId: string): void {
    for (const [jobId, pending] of this.#pending) {
      if (pending.runnerId !== runnerId) continue
      clearTimeout(pending.timer)
      pending.reject(new RunnerDisconnected())
      this.#pending.delete(jobId)
    }
  }

  // Sends a setup job and waits for its result. Throws an API failure when
  // the runner is offline, so routes report it plainly.
  request<K extends SetupJob['kind']>(job: Extract<SetupJob, { kind: K }>, timeoutMs = JOB_TIMEOUT_MS): Promise<Extract<SetupJobResult, { kind: K }>> {
    if (job.kind === 'cleanup_worktrees') {
      const ids = [...this.#runners.keys()].filter(id => this.isOnline(id))
      if (!ids.length) return Promise.reject(runnerOffline())
      return Promise.all(ids.map(id => this.#request<'cleanup_worktrees'>(job as Extract<SetupJob, { kind: 'cleanup_worktrees' }>, timeoutMs, id))).then(results => ({
        kind: 'cleanup_worktrees',
        removed: results.flatMap(r => r.removed),
        kept: results.flatMap(r => r.kept)
      }) as Extract<SetupJobResult, { kind: K }>)
    }
    const runnerId = this.pick(job.kind === 'release_notes' ? (job as Extract<SetupJob, { kind: 'release_notes' }>).runtime : undefined)
    if (!runnerId) return Promise.reject(runnerOffline())
    return this.#request(job, timeoutMs, runnerId)
  }

  // A job for one runner: an integration's candidate only exists where it was built
  requestOn<K extends SetupJob['kind']>(runnerId: string, job: Extract<SetupJob, { kind: K }>, timeoutMs: number): Promise<Extract<SetupJobResult, { kind: K }>> {
    if (!this.isOnline(runnerId)) return Promise.reject(runnerOffline())
    return this.#request(job, timeoutMs, runnerId)
  }

  // Every online runner sweeps. Each answer settles on its own, so one runner
  // failing doesn't lose what the others removed.
  sweepWorktrees(job: Extract<SetupJob, { kind: 'sweep_worktrees' }>, timeoutMs: number): Promise<PromiseSettledResult<Extract<SetupJobResult, { kind: 'sweep_worktrees' }>>[]> {
    return Promise.allSettled(this.available().map(r => this.#request(job, timeoutMs, r.id)))
  }

  #request<K extends SetupJob['kind']>(job: Extract<SetupJob, { kind: K }>, timeoutMs: number, runnerId: string): Promise<Extract<SetupJobResult, { kind: K }>> {
    const jobId = randomUUID()
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#pending.delete(jobId)
        reject(new Error(`Runner job ${job.kind} timed out`))
      }, timeoutMs)
      this.#pending.set(jobId, { resolve: resolve as (r: SetupJobResult) => void, reject, timer, runnerId })
      this.send({ type: 'job.request', jobId, job }, runnerId)
    })
  }

  async #handle(message: RunnerMessage, runnerId: string): Promise<void> {
    switch (message.type) {
      case 'runner.update-status': {
        const runner = this.#runners.get(runnerId)!
        const wasDraining = runner.status.draining
        Object.assign(runner.status, { draining: message.updateState === 'failed' ? false : runner.status.draining || message.draining, updateRequested: message.updateState === 'failed' ? false : runner.status.updateRequested || message.updateRequested, activeRunCount: message.activeRunCount, updateState: message.updateState, updateError: message.updateError })
        this.#publishStatus()
        if (wasDraining && !runner.status.draining) this.#handlers?.onReady()
        return
      }
      case 'runner.draining':
        this.drain(runnerId, message.updateRequested)
        return
      case 'heartbeat':
        this.#runners.get(runnerId)!.status.lastHeartbeatAt = new Date().toISOString()
        this.#publishStatus()
        await this.#handlers?.onHeartbeat(message.activeRuns, runnerId, message.sentAt)
        return
      case 'job.result': {
        const pending = this.#pending.get(message.jobId)
        if (!pending || pending.runnerId !== runnerId) return
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
        const next = previous.then(() => this.#handlers?.onRunMessage(message, runnerId)).catch(error => console.error(`Runner message ${message.type} failed`, error))
        this.#queues.set(message.runId, next)
        await next
        // Idle again: a run that never gets its run.ended leaves nothing behind
        if (this.#queues.get(message.runId) === next) this.#queues.delete(message.runId)
        return
      }
      case 'tool.call': {
        if (!this.#handlers) return
        try {
          const result = await this.#handlers.onToolCall(message, runnerId)
          this.send({ type: 'tool.result', callId: message.callId, ok: true, result }, runnerId)
        } catch (error) {
          this.send({ type: 'tool.result', callId: message.callId, ok: false, error: error instanceof Error ? error.message : String(error) }, runnerId)
        }
        return
      }
      // A run.message the runner couldn't deliver (POST /projects/:slug/runs/:runId/messages).
      // The runner has already noted it in the run's transcript.
      case 'run.message.rejected':
        console.warn(`Run ${message.runId} did not take a message: ${message.error}`)
        return
      case 'hello':
        return
    }
  }

  #publishStatus(): void {
    this.#events.publish({ type: 'runner.status', status: this.status() })
  }
}

// A hello's capacity, checked: anything missing falls back to `fallback`
function parseCapacity(message: Extract<RunnerMessage, { type: 'hello' }>, fallback?: RunnerCapacity): RunnerCapacity {
  return {
    slotSource: parseSlotSource(message.slotSource),
    slots: typeof message.slots === 'number' && Number.isInteger(message.slots) && message.slots > 0 ? message.slots : fallback?.slots ?? 1,
    runtimes: Array.isArray(message.runtimes) ? message.runtimes.filter(r => typeof r === 'string') : fallback?.runtimes ?? [],
    roles: Array.isArray(message.roles) ? message.roles.filter(r => (RUNNER_ROLES as readonly string[]).includes(r)) : fallback?.roles ?? []
  }
}

// How long without a heartbeat before the server treats the runner as gone,
// even if the socket hasn't closed (e.g. a sleeping laptop)
export const RUNNER_STALE_MS = RUNNER_HEARTBEAT_MS * 3

function parseSlotSource(source: SlotSource | undefined): SlotSource | undefined {
  if (source?.kind === 'explicit') return { kind: 'explicit' }
  if (source?.kind !== 'derived') return undefined
  const { cpus, memoryBytes, slotCpus, slotMemoryBytes } = source
  if (![cpus, memoryBytes, slotCpus, slotMemoryBytes].every(n => Number.isFinite(n) && n > 0)) return undefined
  return { kind: 'derived', cpus, memoryBytes, slotCpus, slotMemoryBytes }
}

export function runnerOffline(): ApiFailure {
  return new ApiFailure(503, { code: 'runner_offline' })
}
