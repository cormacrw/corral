import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { GitAuthor } from './config.ts'
import { StreamJsonParser, type ParsedLine } from './stream-json.ts'

// The Claude Code AgentRuntime adapter (agent-runtime-and-auth.md). Auth is
// the CLI's own business: it reads its login from the user's config and
// Corral never sees it (D2). Everything provider-specific lives here, so
// another CLI means another adapter, not changes to the run manager.

export interface AgentOptions {
  claudeBin: string
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

export const STOP_GRACE_MS = 5_000

type ArgOptions = Pick<AgentOptions, 'systemPrompt' | 'mcpConfigPath' | 'model' | 'resumeSessionId'>

// One-shot runs pass the prompt with -p. A streaming session passes none: it
// reads user messages from stdin, which the CLI only allows with --print.
export function agentArgs(options: ArgOptions & ({ prompt: string } | { input: 'stream-json' })): string[] {
  const args = 'prompt' in options
    ? ['-p', options.prompt]
    : ['--print', '--input-format', 'stream-json']
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
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']) delete env[key]
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
  return { pid: child.pid ?? -1, exited, kill: signal => killGroup(child, signal) }
}

export type AgentOptionsWithoutPrompt = Omit<AgentOptions, 'prompt'>

export type TurnResult = NonNullable<ParsedLine['result']>

export interface AgentSession extends AgentProcess {
  // Writes one user message. A no-op once the process has exited.
  send(prompt: string): void
  // The next turn's result line, in order. Resolves null if the process
  // ends first, so a caller waiting on a killed or crashed turn never hangs.
  nextResult(): Promise<TurnResult | null>
}

// A long-lived agent that takes turns over stdin: each send() is one user
// message, and each turn ends with a result line. onLine still sees every line.
export function spawnAgentSession(options: AgentOptionsWithoutPrompt): AgentSession {
  const results: TurnResult[] = []
  const waiting: ((result: TurnResult | null) => void)[] = []
  let ended = false
  const { child, exited, parser } = startAgent(agentArgs({ ...options, input: 'stream-json' }), 'pipe', {
    ...options,
    onLine(raw, parsed) {
      options.onLine(raw, parsed)
      if (!parsed.result) return
      const next = waiting.shift()
      if (next) next(parsed.result)
      else results.push(parsed.result)
    }
  })
  const stdin = child.stdin!
  // Writing after the process died raises EPIPE; exited already reports that
  stdin.on('error', () => {})
  void exited.then(() => {
    ended = true
    for (const resolve of waiting.splice(0)) resolve(null)
  })

  return {
    pid: child.pid ?? -1,
    exited,
    kill: signal => killGroup(child, signal),
    send(prompt) {
      if (ended || !stdin.writable) return
      parser.startTurn()
      stdin.write(JSON.stringify({ type: 'user', message: { role: 'user', content: prompt } }) + '\n')
    },
    nextResult() {
      const result = results.shift()
      if (result) return Promise.resolve(result)
      if (ended) return Promise.resolve(null)
      return new Promise(resolve => waiting.push(resolve))
    }
  }
}

function startAgent(args: string[], stdin: 'ignore' | 'pipe', options: AgentOptionsWithoutPrompt): { child: ChildProcess, exited: Promise<AgentExit>, parser: StreamJsonParser } {
  const parser = new StreamJsonParser({ quietResumeOf: options.quietResume ? options.resumeSessionId : null })
  const child = spawn(options.claudeBin, args, {
    cwd: options.cwd,
    env: agentEnv(process.env, options.gitAuthor),
    // Its own process group, so the whole tree can be killed at once
    detached: true,
    stdio: [stdin, 'pipe', 'pipe']
  })

  // Line by line, never the whole transcript in memory (runner rule 3)
  const stdout = createInterface({ input: child.stdout! })
  stdout.on('line', line => options.onLine(line, parser.parse(line)))
  let stderr = ''
  child.stderr!.setEncoding('utf8').on('data', (chunk: string) => {
    // Keep only the tail: enough to explain a crash
    stderr = (stderr + chunk).slice(-4000)
  })

  const exited = new Promise<AgentExit>((resolve) => {
    child.on('error', (error) => {
      options.onLine('', { events: [{ type: 'system', text: `Could not start the agent: ${error.message}` }], sessionId: null, rateLimit: null, result: null })
      resolve({ code: null, signal: null })
    })
    child.on('close', (code, signal) => {
      if (code !== 0 && stderr.trim()) {
        options.onLine('', { events: [{ type: 'system', text: stderr.trim() }], sessionId: null, rateLimit: null, result: null })
      }
      resolve({ code, signal })
    })
  })
  return { child, exited, parser }
}

function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // The group is already gone
  }
}
