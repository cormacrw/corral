import type { CheckScope } from '@corral/contracts'
import type { AgentRuntime as RuntimeId } from '@corral/core'
import type { GitAuthor } from './config.ts'
import type { ParsedLine } from './parsed-line.ts'

// The AgentRuntime interface (agent-runtime-and-auth.md). The run manager
// starts agents only through it, picking the adapter by the job's runtime id
// (D15). Everything that differs between CLIs lives in the adapters (claude.ts,
// codex.ts); runtimes.ts builds the registry.

export type ParsedLineHandler = (raw: string, parsed: ParsedLine) => void

export interface McpServer {
  type?: string
  url?: string
  command?: string
  args?: string[]
}

export interface SessionOptions {
  cwd: string
  // The run's own folder outside the checkout; an adapter may keep files there
  scratchDir: string
  // cwd isn't a checkout: a global PM session (D30)
  noRepository: boolean
  // Role instructions from the repo, plus the runner's notes
  systemPrompt: string
  mcpServers: Record<string, McpServer>
  model: string | null
  resumeSessionId: string | null
  // Resuming this session adds no "Session started" note (PM follow-up turns)
  quietResume: boolean
  gitAuthor: GitAuthor | null
  checkScope: CheckScope | null
  // The project's shared Turbo cache on this runner (turboCachePath)
  turboCacheDir: string | null
  onLine: ParsedLineHandler
}

export interface RuntimeOptions extends SessionOptions {
  prompt: string
}

export interface AgentExit {
  code: number | null
  signal: NodeJS.Signals | null
}

export interface AgentProcess {
  pid: number
  exited: Promise<AgentExit>
  // Signals the whole process group: dev servers and browsers the agent
  // started go with it (architecture.md, runner rule 2)
  kill(signal: NodeJS.Signals): void
}

export type TurnResult = NonNullable<ParsedLine['result']>

export interface AgentSession extends AgentProcess {
  // Writes one user message that starts a new run's turn. A no-op once the
  // process has exited.
  send(prompt: string): void
  // Writes a user message within the current run, whose usage totals carry
  // on. Claude Code takes it in the turn under way, or as the next turn.
  // False once the process has exited or stdin is closed.
  message(text: string): boolean
  // Closes stdin: the CLI finishes the turn under way, then exits
  close(): void
  // The next turn's result line, in order. Resolves null if the process
  // ends first, so a caller waiting on a killed or crashed turn never hangs.
  nextResult(): Promise<TurnResult | null>
  // The next result line by which the agent had taken in every message()
  // and answered it: nothing is left for it to do. Null if the process ends first.
  nextIdle(): Promise<TurnResult | null>
}

// What a run needs from an adapter
export interface AgentLauncher {
  id: string
  // Does the disk work a start needs, off the event loop's main path (runner
  // rule 1). spawn and spawnSession get what this returns, so call it first.
  prepare?<T extends SessionOptions>(options: T): Promise<T>
  // A one-shot run: answers the prompt and exits
  spawn(options: RuntimeOptions): AgentProcess
  // A long-lived process that takes turns, and messages mid-run. Runtimes
  // without it never keep a PM session warm or take messages; each turn
  // cold-starts with a resume instead (D9).
  spawnSession?(options: SessionOptions): AgentSession
}

interface CliDetection {
  version: string | null
  signedIn: boolean
}

interface AskOptions {
  model: string | null
  timeoutMs: number
}

export interface AgentRuntime extends AgentLauncher {
  id: RuntimeId
  // The CLI's version and whether it is signed in. Corral never reads the login itself (D2).
  detect(): Promise<CliDetection>
  // One non-interactive call with no tools, no MCP servers and no saved
  // session, from a folder with no project docs. It runs outside the
  // RunManager, so it never takes a slot or waits for one (COR-40).
  ask(prompt: string, options: AskOptions): Promise<string>
  // The user-skills folder the CLI reads
  skillsDir: string
}

export type RuntimeRegistry = ReadonlyMap<string, AgentLauncher>
