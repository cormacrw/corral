import type { SetupJobResult } from '@corral/contracts'
import { AGENT_RUNTIMES, RUNTIMES_TAKING_MESSAGES, type AgentRuntime as RuntimeId } from '@corral/core'
import type { AgentRuntime } from './agent-runtime.ts'
import { claudeCodeRuntime } from './claude.ts'
import { codexRuntime } from './codex.ts'
import type { RunnerConfig } from './config.ts'

// This runner's agent runtimes, one adapter per CLI (D15, D18)
export class Runtimes {
  readonly #byId: ReadonlyMap<string, AgentRuntime>
  #detection: Promise<DetectedCli[]> | null = null

  constructor(runtimes: AgentRuntime[]) {
    // The server pins messages to live runs only for these (human-actions); a
    // runtime with a streaming session takes them here
    for (const runtime of runtimes) {
      if ((runtime.spawnSession !== undefined) !== RUNTIMES_TAKING_MESSAGES.includes(runtime.id)) {
        throw new Error(`The ${runtime.id} adapter and RUNTIMES_TAKING_MESSAGES disagree about whether it takes messages`)
      }
    }
    this.#byId = new Map(runtimes.map(runtime => [runtime.id, runtime]))
  }

  // What the run manager starts agents through
  get registry(): ReadonlyMap<string, AgentRuntime> {
    return this.#byId
  }

  get(id: string): AgentRuntime | undefined {
    return this.#byId.get(id)
  }

  // Each hello and the server's check right after it would otherwise run the
  // same commands. Calls share one detection, and a full result is reused
  // for a while. One with a CLI signed out isn't: someone may be signing in.
  detect(): Promise<DetectedCli[]> {
    if (this.#detection) return this.#detection
    const forget = () => {
      if (this.#detection === detection) this.#detection = null
    }
    const detection = Promise.all([...this.#byId.values()].map(async runtime => ({ id: AGENT_RUNTIMES[runtime.id], ...await runtime.detect() })))
    this.#detection = detection
    void detection.then((clis) => {
      if (clis.every(cli => cli.signedIn)) setTimeout(forget, CLI_DETECTION_TTL_MS).unref()
      else forget()
    }, forget)
    return detection
  }

  // The runtime ids whose CLI is installed and signed in, for the runner's hello
  async signedIn(): Promise<RuntimeId[]> {
    const clis = await this.detect()
    return [...this.#byId.values()].filter((_, i) => clis[i]!.signedIn).map(runtime => runtime.id)
  }
}

type DetectedCli = Extract<SetupJobResult, { kind: 'detect_clis' }>['clis'][number]

const CLI_DETECTION_TTL_MS = 30_000

export function createRuntimes(config: RunnerConfig): Runtimes {
  return new Runtimes([
    claudeCodeRuntime({ bin: config.claudeBin, configDir: config.claudeConfigDir }),
    codexRuntime({ bin: config.codexBin, home: config.codexHome })
  ])
}
