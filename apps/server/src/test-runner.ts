import { RUNNER_PROTOCOL_VERSION, RUNNER_ROLES, type AgentTool, type RunnerCapacity, type RunnerMessage, type ServerMessage, type SetupJobResult } from '@corral/contracts'
import WebSocket from 'ws'

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// A fake runner: a WebSocket client that records what the server sends and
// lets tests answer as a runner would
export class FakeRunner {
  socket: WebSocket
  received: ServerMessage[] = []
  #waiters: { match: (m: ServerMessage) => boolean, resolve: (m: ServerMessage) => void }[] = []

  // Answers setup jobs the server sends (e.g. cleanup_worktrees). Both CLIs
  // are installed and signed in unless a test says otherwise. Throwing
  // answers with an error; session titles fail unless a test says otherwise,
  // so the fallback title stays.
  onJob: (job: Extract<ServerMessage, { type: 'job.request' }>['job']) => SetupJobResult | null = (job) => {
    if (job.kind === 'cleanup_worktrees') return { kind: 'cleanup_worktrees', removed: [`worktrees/${job.taskId}`], kept: [] }
    if (job.kind === 'session_title') throw new Error('No title in tests')
    if (job.kind === 'detect_clis') return { kind: 'detect_clis', clis: [{ id: 'claude', version: '2.0.0', signedIn: true }, { id: 'codex', version: '0.50.0', signedIn: true }] }
    return null
  }

  constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage
      if (message.type === 'job.request') {
        try {
          const result = this.onJob(message.job)
          if (result) this.send({ type: 'job.result', jobId: message.jobId, ok: true, result })
        } catch (error) {
          this.send({ type: 'job.result', jobId: message.jobId, ok: false, error: (error as Error).message })
        }
      }
      this.received.push(message)
      const index = this.#waiters.findIndex(w => w.match(message))
      if (index >= 0) this.#waiters.splice(index, 1)[0]!.resolve(message)
    })
  }

  // Takes every role and runtime with plenty of slots unless a test says otherwise
  static async connect(url: string, activeRuns: { runId: string, leaseEpoch: number }[] = [], runnerId = 'r1', capacity: Partial<RunnerCapacity> = {}): Promise<FakeRunner> {
    const socket = new WebSocket(`${url.replace('http', 'ws')}/runner`)
    const runner = new FakeRunner(socket)
    await new Promise(resolve => socket.once('open', resolve))
    runner.send({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, runnerId, name: runnerId, activeRuns, slots: 10, runtimes: ['claude-code', 'codex'], roles: [...RUNNER_ROLES], ...capacity })
    await runner.next('welcome')
    return runner
  }

  send(message: RunnerMessage): void {
    this.socket.send(JSON.stringify(message))
  }

  next<T extends ServerMessage['type']>(type: T, match: (m: Extract<ServerMessage, { type: T }>) => boolean = () => true): Promise<Extract<ServerMessage, { type: T }>> {
    const matcher = (m: ServerMessage) => m.type === type && match(m as Extract<ServerMessage, { type: T }>)
    const already = this.received.find(matcher)
    if (already) {
      this.received.splice(this.received.indexOf(already), 1)
      return Promise.resolve(already as Extract<ServerMessage, { type: T }>)
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`No ${type} message within 5 s`)), 5000)
      this.#waiters.push({ match: matcher, resolve: (m) => {
        clearTimeout(timer)
        this.received.splice(this.received.indexOf(m), 1)
        resolve(m as Extract<ServerMessage, { type: T }>)
      } })
    })
  }

  async call(runId: string, leaseEpoch: number, tool: AgentTool, input: unknown) {
    const callId = `call-${Math.random()}`
    this.send({ type: 'tool.call', callId, runId, leaseEpoch, tool, input })
    return this.next('tool.result', m => m.callId === callId)
  }

  close(): void {
    this.socket.close()
  }
}
