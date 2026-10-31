import { claudeCodeRuntime } from './agent.ts'
import { codexRuntime } from './codex.ts'
import type { GitAuthor, RunnerConfig } from './config.ts'
import type { ParsedLine } from './stream-json.ts'

// The AgentRuntime interface (agent-runtime-and-auth.md). The run manager
// starts agents only through it, picking the adapter by the job's runtime id
// (D15), so another CLI means another adapter here, not changes there. Each
// adapter turns its CLI's output into neutral ParsedLines.

export type { ParsedLine } from './stream-json.ts'

export interface RuntimeOptions {
  cwd: string
  prompt: string
  // Role instructions from the repo, plus the runner's notes
  systemPrompt: string
  mcpConfigPath: string
  model: string | null
  resumeSessionId: string | null
  // Set on PM follow-up turns: resuming this session adds no "Session started" note
  quietResume?: boolean
  gitAuthor: GitAuthor | null
  onLine(raw: string, parsed: ParsedLine): void
}

export type SessionOptions = Omit<RuntimeOptions, 'prompt'>

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

export const STOP_GRACE_MS = 5_000

export interface AgentRuntime {
  id: string
  // Reads what a one-shot run needs from disk, off the event loop's main path
  // (runner rule 1). spawn gets what this returns, so call it first when defined.
  prepare?(options: RuntimeOptions): Promise<RuntimeOptions>
  // A one-shot run: answers the prompt and exits
  spawn(options: RuntimeOptions): AgentProcess
  // A long-lived process that takes turns. Runtimes without it never keep a
  // PM session warm; each turn cold-starts with a resume instead (D9).
  spawnSession?(options: SessionOptions): AgentSession
}

export type RuntimeRegistry = ReadonlyMap<string, AgentRuntime>

export function createRuntimeRegistry(config: RunnerConfig): RuntimeRegistry {
  const runtimes: AgentRuntime[] = [claudeCodeRuntime(config.claudeBin), codexRuntime(config.codexBin)]
  return new Map(runtimes.map(runtime => [runtime.id, runtime]))
}
