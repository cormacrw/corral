import { RUNNER_PROTOCOL_VERSION, RUNNER_ROLES, type AgentTool, type RunnerMessage, type ServerMessage, type SetupJobResult } from '@corral/contracts'
import { AGENT_TOOL_CONTRACT } from '@corral/contracts/agent-tools'
import { AGENT_RUNTIME_IDS } from '@corral/core'
import WebSocket from 'ws'
import type { EventBus } from './events.ts'

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// Resolves once the server has handled run.started for the run, whose last
// step publishes run.updated. Subscribe before sending it.
export function runStartHandled(bus: EventBus, runId: string): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const unsubscribe = bus.subscribe((event) => {
      if (event.type !== 'run.updated' || event.run.id !== runId) return
      clearTimeout(timer)
      unsubscribe()
      resolve()
    })
    const timer = setTimeout(() => {
      unsubscribe()
      reject(new Error(`run.started for ${runId} was not handled within 5 s`))
    }, 5000)
  })
}

// What fake runners, in tests and the demo, say is installed
export const FAKE_CLIS = [{ id: 'claude', version: '2.1.0', signedIn: true }, { id: 'codex', version: '0.52.0', signedIn: true }] as const satisfies Extract<SetupJobResult, { kind: 'detect_clis' }>['clis']

// Answers to the setup jobs any fake runner can do the same way
export function answerSetupJob(job: Extract<ServerMessage, { type: 'job.request' }>['job']): SetupJobResult | null {
  if (job.kind === 'cleanup_worktrees') return { kind: 'cleanup_worktrees', removed: [`worktrees/${job.taskId ?? job.epicId}`], kept: [] }
  if (job.kind === 'sweep_worktrees') return { kind: 'sweep_worktrees', removed: [], kept: [] }
  if (job.kind === 'detect_clis') return { kind: 'detect_clis', clis: [...FAKE_CLIS] }
  return null
}

// A fake runner: a WebSocket client that records what the server sends and
// lets tests, and the demo (src/demo/), answer as a runner would
export class FakeRunner {
  socket: WebSocket
  received: ServerMessage[] = []
  #waiters: { match: (m: ServerMessage) => boolean, resolve: (m: ServerMessage) => void }[] = []

  // Answers setup jobs the server sends (e.g. cleanup_worktrees). Both CLIs
  // are installed and signed in unless a test says otherwise. Throwing
  // answers with an error; session titles fail unless a test says otherwise,
  // so the fallback title stays. Release notes jobs are left to each test.
  onJob: (job: Extract<ServerMessage, { type: 'job.request' }>['job']) => SetupJobResult | null | Promise<SetupJobResult | null> = (job) => {
    if (job.kind === 'inbox_message') throw new Error('No message in tests')
    if (job.kind === 'session_title') throw new Error('No title in tests')
    return answerSetupJob(job)
  }

  constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage
      if (message.type === 'job.request') {
        void (async () => {
          try {
            const result = await this.onJob(message.job)
            if (result) this.send({ type: 'job.result', jobId: message.jobId, ok: true, result })
          } catch (error) {
            this.send({ type: 'job.result', jobId: message.jobId, ok: false, error: (error as Error).message })
          }
        })()
      }
      this.received.push(message)
      const index = this.#waiters.findIndex(w => w.match(message))
      if (index >= 0) this.#waiters.splice(index, 1)[0]!.resolve(message)
    })
  }

  // Takes every role and runtime with plenty of slots unless a test says otherwise
  static async connect(url: string, activeRuns: { runId: string, leaseEpoch: number }[] = [], runnerId = 'r1', capacity: Partial<Omit<Extract<RunnerMessage, { type: 'hello' }>, 'type'>> = {}): Promise<FakeRunner> {
    const socket = new WebSocket(`${url.replace('http', 'ws')}/runner`)
    const runner = new FakeRunner(socket)
    await new Promise(resolve => socket.once('open', resolve))
    runner.send({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, commit: 'development', toolContract: AGENT_TOOL_CONTRACT, runnerId, name: runnerId, activeRuns, slots: 10, runtimes: [...AGENT_RUNTIME_IDS], roles: [...RUNNER_ROLES], ...capacity })
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
