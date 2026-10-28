import type { AgentTool, RunnerMessage, ServerMessage, SetupJobResult } from '@corral/contracts'
import WebSocket from 'ws'

export const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

// A fake runner: a WebSocket client that records what the server sends and
// lets tests answer as a runner would
export class FakeRunner {
  socket: WebSocket
  received: ServerMessage[] = []
  #waiters: { match: (m: ServerMessage) => boolean, resolve: (m: ServerMessage) => void }[] = []

  // Answers setup jobs the server sends (e.g. cleanup_worktrees)
  onJob: (job: Extract<ServerMessage, { type: 'job.request' }>['job']) => SetupJobResult | null = (job) => {
    if (job.kind === 'cleanup_worktrees') return { kind: 'cleanup_worktrees', removed: [`worktrees/${job.taskId}`], kept: [] }
    return null
  }

  constructor(socket: WebSocket) {
    this.socket = socket
    socket.on('message', (data) => {
      const message = JSON.parse(String(data)) as ServerMessage
      if (message.type === 'job.request') {
        const result = this.onJob(message.job)
        if (result) this.send({ type: 'job.result', jobId: message.jobId, ok: true, result })
      }
      this.received.push(message)
      const index = this.#waiters.findIndex(w => w.match(message))
      if (index >= 0) this.#waiters.splice(index, 1)[0]!.resolve(message)
    })
  }

  static async connect(url: string, activeRuns: { runId: string, leaseEpoch: number }[] = []): Promise<FakeRunner> {
    const socket = new WebSocket(`${url.replace('http', 'ws')}/runner`)
    const runner = new FakeRunner(socket)
    await new Promise(resolve => socket.once('open', resolve))
    runner.send({ type: 'hello', protocol: 1, runnerId: 'r1', name: 'fake', activeRuns })
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
