import type { RunJob } from '@corral/contracts'
import type { AgentExit, AgentLauncher, AgentSession } from './agent-runtime.ts'
import { terminate } from './agent-process.ts'
import type { Run } from './run.ts'

// A PM session's agent process kept alive between turns (D9). It holds no
// concurrency slot while idle (D13): the slot belongs to the run, which ended.
export interface WarmSession {
  planSessionId: string
  session: AgentSession
  runtime: string
  model: string | null
  // The agent session it holds, known once the init line arrives
  sessionId: string | null
  // The turn it is answering; null while idle
  run: Run | null
  alive: boolean
  idleTimer: NodeJS.Timeout | null
  unregisterTools: () => void
}

export class WarmSessions {
  // Keyed by planSessionId
  #warm = new Map<string, WarmSession>()
  #idleSeconds: number

  constructor(idleSeconds: number) {
    this.#idleSeconds = idleSeconds
  }

  // Only runtimes with a streaming session can keep one warm
  keeps(job: RunJob, runtime: AgentLauncher | null | undefined): boolean {
    return job.role === 'pm' && job.planSessionId !== null && this.#idleSeconds > 0 && runtime?.spawnSession !== undefined
  }

  // The session's warm process, if it can take this turn. One that can't
  // (dead, busy, another agent session, runtime or model) is killed, and the
  // turn cold-starts with a resume as usual.
  async take(job: RunJob): Promise<WarmSession | null> {
    const warm = this.#warm.get(job.planSessionId!)
    if (!warm) return null
    if (warm.alive && warm.run === null && warm.sessionId !== null && warm.sessionId === job.agentSessionId && warm.runtime === job.runtime && warm.model === job.model) return warm
    await this.kill(warm)
    return null
  }

  add(job: RunJob, session: AgentSession, unregisterTools: () => void): WarmSession {
    const warm: WarmSession = {
      planSessionId: job.planSessionId!,
      session,
      runtime: job.runtime,
      model: job.model,
      sessionId: null,
      run: null,
      alive: true,
      idleTimer: null,
      unregisterTools
    }
    this.#warm.set(warm.planSessionId, warm)
    void session.exited.then(() => {
      warm.alive = false
      this.#drop(warm)
    })
    return warm
  }

  // Sends one turn and waits for its result line. Returns null when the
  // process answered and stays warm, or its exit when it ended instead.
  async turn(run: Run, warm: WarmSession, prompt: string): Promise<AgentExit | null> {
    if (warm.idleTimer) clearTimeout(warm.idleTimer)
    warm.idleTimer = null
    warm.run = run
    run.process = warm.session
    // A stop that arrived while the turn was setting up
    if (run.stop) warm.session.kill('SIGTERM')
    else warm.session.send(prompt)
    const result = await warm.session.nextResult()
    warm.run = null
    if (result === null) {
      const exit = await warm.session.exited
      run.agent.exitCode = exit.code
      return exit
    }
    run.agent.exitCode = result.isError ? 1 : 0
    warm.sessionId = run.agent.sessionId
    // A stopped turn already took its process down
    if (!run.stop) warm.idleTimer = setTimeout(() => void this.kill(warm), this.#idleSeconds * 1000)
    return null
  }

  async kill(warm: WarmSession): Promise<void> {
    this.#drop(warm)
    if (warm.run) warm.run.agent.signalledByCorral = true
    terminate(warm.session)
    await warm.session.exited
    // Anything the agent started that outlived it goes too
    warm.session.kill('SIGKILL')
  }

  killAll(): Promise<void[]> {
    return Promise.all([...this.#warm.values()].map(warm => this.kill(warm)))
  }

  #drop(warm: WarmSession): void {
    if (warm.idleTimer) clearTimeout(warm.idleTimer)
    warm.idleTimer = null
    warm.unregisterTools()
    if (this.#warm.get(warm.planSessionId) === warm) this.#warm.delete(warm.planSessionId)
  }
}
