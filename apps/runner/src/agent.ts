import { spawn, type ChildProcess } from 'node:child_process'
import { createInterface } from 'node:readline'
import type { AgentExit, AgentProcess, AgentRuntime, AgentSession, RuntimeOptions, TurnResult } from './agent-runtime.ts'
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
    pid: child.pid ?? -1,
    exited,
    kill: signal => killGroup(child, signal),
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

// Starts an agent CLI in the worktree with agentEnv, in its own process
// group, feeding each stdout line through the adapter's parser to onLine
export function startProcess(
  bin: string,
  args: string[],
  stdin: 'ignore' | 'pipe',
  options: Pick<RuntimeOptions, 'cwd' | 'gitAuthor' | 'onLine'>,
  parser: { parse(line: string): ParsedLine }
): { child: ChildProcess, exited: Promise<AgentExit> } {
  const child = spawn(bin, args, {
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
  return { child, exited }
}

export function killGroup(child: ChildProcess, signal: NodeJS.Signals): void {
  if (!child.pid) return
  try {
    process.kill(-child.pid, signal)
  } catch {
    // The group is already gone
  }
}
