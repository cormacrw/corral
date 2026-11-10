import type { CheckScope } from '@corral/contracts'
import { errorText } from '@corral/core'
import { spawn, type ChildProcess } from 'node:child_process'
import { tmpdir } from 'node:os'
import { basename } from 'node:path'
import { StringDecoder } from 'node:string_decoder'
import type { AgentExit, AgentProcess, SessionOptions } from './agent-runtime.ts'
import type { GitAuthor } from './config.ts'
import { exec, groupAlive, signalGroup, STOP_GRACE_MS } from './exec.ts'
import type { ParsedLine } from './parsed-line.ts'

// Starting an agent CLI and reading its output, the same for every adapter.

// The agent's environment: no GitHub token, and a git config whose push URL
// fails, so only the runner pushes (architecture.md, known POC limitation).
// No CORRAL_* settings either: an agent working on Corral itself that starts
// a runner would otherwise join this runner's server and share its data dir.
// The configured git identity goes in as GIT_AUTHOR_*/GIT_COMMITTER_*, which
// git prefers over any user.name/user.email the agent writes to its config.
// CORRAL_CHECK_SCOPE is the one exception: it's about this run, and a project's
// check script can honour it (docs/agent-runtime-and-auth.md).
// TURBO_CACHE_DIR points at the project's shared Turbo cache on this runner, so
// a new worktree doesn't start cold; an operator's own value wins
// (.corral/wiki/turbo-cache.md). `strip` is what the adapter's CLI must not inherit.
export function agentEnv(base: NodeJS.ProcessEnv = process.env, gitAuthor: GitAuthor | null = null, checkScope: CheckScope | null = null, turboCacheDir: string | null = null, strip: readonly string[] = []): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base }
  for (const key of ['GH_TOKEN', 'GITHUB_TOKEN', 'GH_ENTERPRISE_TOKEN', 'NODE_ENV', ...strip]) delete env[key]
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
  if (checkScope) env.CORRAL_CHECK_SCOPE = checkScope
  if (turboCacheDir && !env.TURBO_CACHE_DIR) env.TURBO_CACHE_DIR = turboCacheDir
  return env
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

type ProcessOptions = Pick<SessionOptions, 'cwd' | 'gitAuthor' | 'checkScope' | 'turboCacheDir' | 'onLine'>

interface StartOptions {
  bin: string
  args: string[]
  stdin: 'ignore' | 'pipe'
  // Written to stdin, which is then closed
  input?: string
  // Variables the CLI must not inherit from the runner
  envToStrip: readonly string[]
  parser: { parse(line: string): ParsedLine }
}

// Starts an agent CLI in the worktree with agentEnv, in its own process
// group, feeding each stdout line through the adapter's parser to onLine.
export function startProcess(start: StartOptions, options: ProcessOptions): { child: ChildProcess, exited: Promise<AgentExit> } {
  const child = spawn(start.bin, start.args, {
    cwd: options.cwd,
    env: agentEnv(process.env, options.gitAuthor, options.checkScope, options.turboCacheDir, start.envToStrip),
    // Its own process group, so the whole tree can be killed at once
    detached: true,
    stdio: [start.stdin, 'pipe', 'pipe']
  })
  if (start.stdin === 'pipe') {
    // Writing after the process died raises EPIPE; exited already reports that
    child.stdin!.on('error', () => {})
    if (start.input !== undefined) child.stdin!.end(start.input)
  }

  const note = (text: string) => options.onLine('', { events: [{ type: 'system', text }], sessionId: null, rateLimit: null, result: null })
  // An exception in a stream listener would take down every run on this runner
  const handleLine = (line: string) => {
    try {
      options.onLine(line, start.parser.parse(line))
    } catch (error) {
      note(`Could not read a line of the agent's output: ${errorText(error)}`)
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

// Gracefully first (architecture.md, runner rule 2): SIGTERM after delayMs,
// SIGKILL STOP_GRACE_MS later. Both are called off once `exited` settles; a
// target without one never holds the runner open waiting for the SIGKILL.
export function terminate(target: Pick<AgentProcess, 'kill'> & { exited?: Promise<unknown> }, { delayMs = 0, onTerm }: { delayMs?: number, onTerm?: () => void } = {}): void {
  const term = () => {
    onTerm?.()
    target.kill('SIGTERM')
  }
  let soft: NodeJS.Timeout | undefined
  if (delayMs > 0) soft = setTimeout(term, delayMs)
  else term()
  const hard = setTimeout(() => target.kill('SIGKILL'), delayMs + STOP_GRACE_MS)
  if (!target.exited) {
    hard.unref()
    return
  }
  void target.exited.then(() => {
    clearTimeout(soft)
    clearTimeout(hard)
  })
}

// The CLI has exited, so nothing will stop what it left behind (runner rule 2).
// This doesn't hold up the exit: the run's own work is the runner's git, not
// these. An idle warm process hasn't exited, so its children are left alone.
function stopGroup(child: ChildProcess): void {
  terminate({
    kill: (signal) => {
      if (signal === 'SIGKILL') {
        if (!groupAlive(child.pid)) return
        console.warn(`Process group ${child.pid} outlived its agent and ignored SIGTERM; sending SIGKILL`)
      }
      signalGroup(child.pid, signal)
    }
  })
}

export function agentProcess(child: ChildProcess, exited: Promise<AgentExit>): AgentProcess {
  return { pid: child.pid ?? -1, exited, kill: signal => signalGroup(child.pid, signal) }
}

// One non-interactive CLI call, the prompt on stdin, from a folder with no
// project docs. Its trimmed output is the answer; none is a failure.
export async function askOnce(bin: string, args: string[], prompt: string, timeoutMs: number): Promise<string> {
  const result = await exec(bin, args, { cwd: tmpdir(), input: prompt, timeoutMs })
  const answer = result.stdout.trim()
  if (result.code !== 0 || !answer) throw new Error(result.stderr.trim() || `${basename(bin)} exited with code ${result.code}`)
  return answer
}
