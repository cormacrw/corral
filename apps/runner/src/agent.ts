import { spawn, type ChildProcess } from 'node:child_process'
import { StringDecoder } from 'node:string_decoder'
import { STOP_GRACE_MS, type AgentExit, type AgentProcess, type AgentRuntime, type AgentSession, type RuntimeOptions, type TurnResult } from './agent-runtime.ts'
import type { GitAuthor } from './config.ts'
import { StreamJsonParser, type ParsedLine } from './stream-json.ts'

// The Claude Code AgentRuntime adapter (agent-runtime-and-auth.md). Auth is
// the CLI's own business: it reads its login from the user's config and
// Corral never sees it (D2). Everything provider-specific lives here, so
// another CLI means another adapter, not changes to the run manager.

export interface AgentOptions extends RuntimeOptions {
  claudeBin: string
}

export type { AgentExit, AgentProcess, AgentSession, TurnResult } from './agent-runtime.ts'

// The registry's entry for runtime id 'claude-code'
export function claudeCodeRuntime(claudeBin: string): AgentRuntime {
  return {
    id: 'claude-code',
    spawn: options => spawnAgent({ ...options, claudeBin }),
    spawnSession: options => spawnAgentSession({ ...options, claudeBin })
  }
}

type ArgOptions = Pick<AgentOptions, 'systemPrompt' | 'mcpConfigPath' | 'model' | 'resumeSessionId'>

// One-shot runs pass the prompt with -p. A streaming session passes none: it
// reads user messages from stdin, which the CLI only allows with --print, and
// echoes each one as it takes it in.
export function agentArgs(options: ArgOptions & ({ prompt: string } | { input: 'stream-json' })): string[] {
  const args = 'prompt' in options
    ? ['-p', options.prompt]
    : ['--print', '--input-format', 'stream-json', '--replay-user-messages']
  args.push(
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', options.mcpConfigPath,
    '--strict-mcp-config',
    '--permission-mode', 'bypassPermissions',
    '--append-system-prompt', options.systemPrompt
  )
  if (options.model) args.push('--model', options.model)
  if (options.resumeSessionId) args.push('--resume', options.resumeSessionId)
  return args
}

// The agent's environment: no GitHub token, and a git config whose push URL
// fails, so only the runner pushes (architecture.md, known POC limitation).
// No CORRAL_* settings either: an agent working on Corral itself that starts
// a runner would otherwise join this runner's server and share its data dir.
// The configured git identity goes in as GIT_AUTHOR_*/GIT_COMMITTER_*, which
// git prefers over any user.name/user.email the agent writes to its config.
export function agentEnv(base: NodeJS.ProcessEnv = process.env, gitAuthor: GitAuthor | null = null): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'NODE_ENV']) delete env[key]
  for (const key of Object.keys(env)) {
    if (key.startsWith('GIT_CONFIG_') || key.startsWith('CORRAL_')) delete env[key]
  }
  env.GIT_CONFIG_COUNT = '1'
  env.GIT_CONFIG_KEY_0 = 'remote.origin.pushurl'
  env.GIT_CONFIG_VALUE_0 = 'no-push://corral-pushes-for-you'
  env.GIT_TERMINAL_PROMPT = '0'
  if (gitAuthor) {
    env.GIT_AUTHOR_NAME = env.GIT_COMMITTER_NAME = gitAuthor.name
    env.GIT_AUTHOR_EMAIL = env.GIT_COMMITTER_EMAIL = gitAuthor.email
  }
  return env
}

export function spawnAgent(options: AgentOptions): AgentProcess {
  const { child, exited } = startAgent(agentArgs(options), 'ignore', options)
  return agentProcess(child, exited)
}

export type AgentOptionsWithoutPrompt = Omit<AgentOptions, 'prompt'>

// A long-lived agent that takes turns over stdin: each send() is one user
// message, and each turn ends with a result line. onLine still sees every line.
// A message() can join the turn under way, which then ends with one result
// for both, so each result records whether the CLI had taken in every
// message by then (its replay of the message came first).
export function spawnAgentSession(options: AgentOptionsWithoutPrompt): AgentSession {
  const results: Turn[] = []
  const waiting: ((turn: Turn | null) => void)[] = []
  const unreplayed: string[] = []
  let ended = false
  const { child, exited, parser } = startAgent(agentArgs({ ...options, input: 'stream-json' }), 'pipe', {
    ...options,
    onLine(raw, parsed) {
      options.onLine(raw, parsed)
      if (parsed.replayed !== undefined) {
        const index = unreplayed.indexOf(parsed.replayed)
        if (index >= 0) unreplayed.splice(index, 1)
      }
      if (!parsed.result) return
      const turn = { result: parsed.result, idle: unreplayed.length === 0 }
      const next = waiting.shift()
      if (next) next(turn)
      else results.push(turn)
    }
  })
  const nextTurn = (): Promise<Turn | null> => {
    const turn = results.shift()
    if (turn) return Promise.resolve(turn)
    if (ended) return Promise.resolve(null)
    return new Promise(resolve => waiting.push(resolve))
  }
  const stdin = child.stdin!
  // Writing after the process died raises EPIPE; exited already reports that
  stdin.on('error', () => {})
  const write = (content: string) => stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content } }) + '\n')
  void exited.then(() => {
    ended = true
    for (const resolve of waiting.splice(0)) resolve(null)
  })

  return {
    ...agentProcess(child, exited),
    send(prompt) {
      if (ended || !stdin.writable) return
      parser.startTurn()
      write(prompt)
    },
    message(text) {
      if (ended || !stdin.writable) return false
      unreplayed.push(text)
      write(text)
      return true
    },
    close() {
      stdin.end()
    },
    async nextResult() {
      return (await nextTurn())?.result ?? null
    },
    async nextIdle() {
      for (;;) {
        const turn = await nextTurn()
        if (!turn || turn.idle) return turn?.result ?? null
      }
    }
  }
}

interface Turn {
  result: TurnResult
  // Every message() had been taken in when this result arrived
  idle: boolean
}

function startAgent(args: string[], stdin: 'ignore' | 'pipe', options: AgentOptionsWithoutPrompt): { child: ChildProcess, exited: Promise<AgentExit>, parser: StreamJsonParser } {
  const parser = new StreamJsonParser({ quietResumeOf: options.quietResume ? options.resumeSessionId : null })
  return { ...startProcess(options.claudeBin, args, stdin, options, parser), parser }
}

// Far above a real JSONL line; a longer one is skipped with a note, not held
export const MAX_LINE_CHARS = 8 * 1024 * 1024
// How long after the CLI exits a descendant may keep its pipes open
const EXIT_DRAIN_MS = 2000

// Splits a byte stream on \n alone. JSON leaves U+2028 and U+2029 raw inside
// strings, and readline would cut a line at either.
export class LineSplitter {
  #decoder = new StringDecoder('utf8')
  #parts: string[] = []
  #length = 0
  #skipping = false
  #onLine: (line: string) => void
  #onSkipped: () => void

  constructor(onLine: (line: string) => void, onSkipped: () => void) {
    this.#onLine = onLine
    this.#onSkipped = onSkipped
  }

  write(chunk: Buffer): void {
    let text = this.#decoder.write(chunk)
    for (let end = text.indexOf('\n'); end >= 0; end = text.indexOf('\n')) {
      this.#add(text.slice(0, end))
      this.#finishLine()
      text = text.slice(end + 1)
    }
    this.#add(text)
  }

  // A last line with no \n still counts
  end(): void {
    this.#add(this.#decoder.end())
    if (this.#length > 0) this.#finishLine()
  }

  #add(text: string): void {
    if (this.#skipping || !text) return
    this.#length += text.length
    if (this.#length <= MAX_LINE_CHARS) {
      this.#parts.push(text)
      return
    }
    this.#skipping = true
    this.#parts = []
    this.#onSkipped()
  }

  #finishLine(): void {
    if (!this.#skipping) this.#onLine(this.#parts.join(''))
    this.#parts = []
    this.#length = 0
    this.#skipping = false
  }
}

// Starts an agent CLI in the worktree with agentEnv, in its own process
// group, feeding each stdout line through the adapter's parser to onLine.
// `input` is written to its stdin, which is then closed.
export function startProcess(
  bin: string,
  args: string[],
  stdin: 'ignore' | 'pipe',
  options: Pick<RuntimeOptions, 'cwd' | 'gitAuthor' | 'onLine'>,
  parser: { parse(line: string): ParsedLine },
  input?: string
): { child: ChildProcess, exited: Promise<AgentExit> } {
  const child = spawn(bin, args, {
    cwd: options.cwd,
    env: agentEnv(process.env, options.gitAuthor),
    // Its own process group, so the whole tree can be killed at once
    detached: true,
    stdio: [stdin, 'pipe', 'pipe']
  })
  if (input !== undefined) {
    // Writing after the process died raises EPIPE; exited already reports that
    child.stdin!.on('error', () => {})
    child.stdin!.end(input)
  }

  const note = (text: string) => options.onLine('', { events: [{ type: 'system', text }], sessionId: null, rateLimit: null, result: null })
  // An exception in a stream listener would take down every run on this runner
  const handleLine = (line: string) => {
    try {
      options.onLine(line, parser.parse(line))
    } catch (error) {
      note(`Could not read a line of the agent's output: ${error instanceof Error ? error.message : String(error)}`)
    }
  }
  // Line by line, never the whole transcript in memory (runner rule 3)
  const lines = new LineSplitter(handleLine, () => note(`Skipped a line of the agent's output over ${MAX_LINE_CHARS.toLocaleString('en')} characters`))
  child.stdout!.on('data', (chunk: Buffer) => lines.write(chunk))
  child.stdout!.on('end', () => lines.end())
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    // Keep only the tail: enough to explain a crash
    stderr = (stderr + chunk).slice(-4000)
  })

  const exited = new Promise<AgentExit>((resolve) => {
    let finished = false
    const finish = (code: number | null, signal: NodeJS.Signals | null) => {
      if (finished) return
      finished = true
      lines.end()
      if (code !== 0 && stderr.trim()) note(stderr.trim())
      resolve({ code, signal })
    }
    child.on('error', (error) => {
      note(`Could not start the agent: ${error.message}`)
      finish(null, null)
    })
    child.on('exit', (code, signal) => {
      stopGroup(child)
      // 'close' waits for the pipes, which a process that left the group can
      // hold open forever. Without this the run would never end.
      const stuck = setTimeout(() => {
        child.stdout!.destroy()
        child.stderr!.destroy()
        finish(code, signal)
      }, EXIT_DRAIN_MS)
      child.once('close', () => {
        clearTimeout(stuck)
        finish(code, signal)
      })
    })
  })
  return { child, exited }
}

// The CLI has exited, so nothing will stop what it left behind (runner rule 2).
// This doesn't hold up the exit: the run's own work is the runner's git, not
// these. An idle warm process hasn't exited, so its children are left alone.
function stopGroup(child: ChildProcess): void {
  killGroup(child, 'SIGTERM')
  if (!groupAlive(child)) return
  setTimeout(() => {
    if (!groupAlive(child)) return
    console.warn(`Process group ${child.pid} outlived its agent and ignored SIGTERM; sending SIGKILL`)
    killGroup(child, 'SIGKILL')
  }, STOP_GRACE_MS).unref()
}

function groupAlive(child: ChildProcess): boolean {
  if (!child.pid) return false
  try {
    process.kill(-child.pid, 0)
    return true
  } catch {
    return false
  }
}

export function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // The group is already gone
  }
}

export function agentProcess(child: ChildProcess, exited: Promise<AgentExit>): AgentProcess {
  return { pid: child.pid ?? -1, exited, kill: signal => killGroup(child, signal) }
}
