import { spawn } from 'node:child_process'

export interface ExecResult {
  code: number | null
  stdout: string
  stderr: string
}

export interface ExecOptions {
  cwd?: string
  env?: NodeJS.ProcessEnv
  input?: string
  timeoutMs?: number
  // Runs in its own process group, and a timeout stops the whole group, gently
  // first. For commands whose helpers would outlive them (git-remote-https, gh
  // as a credential helper) and that clean up locks when asked to stop.
  group?: boolean
}

// Far past anything a command here prints, including a paginated `gh api`
export const MAX_OUTPUT_CHARS = 64 * 1024 * 1024
const GROUP_STOP_GRACE_MS = 5000

// Detached groups don't get the terminal's signals, so they go when we do
const groups = new Set<number>()
process.on('exit', () => {
  for (const pid of groups) signalGroup(pid, 'SIGTERM')
})

function signalGroup(pid: number | undefined, signal: NodeJS.Signals): void {
  if (!pid) return
  try {
    process.kill(-pid, signal)
  } catch {
    // The group is already gone
  }
}

// Runs a command without blocking the event loop (architecture.md, runner
// rule 1) and without a shell. Never throws: a missing binary is code null.
export function exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    let failure: string | null = null
    let hardStop: NodeJS.Timeout | undefined
    const done = (result: ExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      clearTimeout(hardStop)
      if (child.pid) groups.delete(child.pid)
      resolve(result)
    }
    const failed = () => ({ code: null, stdout, stderr: `${stderr}\n${failure}` })
    // A command that was only asked to stop gets the grace period to finish
    // cleaning up; the caller hears once it has
    const abort = (reason: string) => {
      if (failure) return
      failure = reason
      if (!options.group) {
        child.kill('SIGKILL')
        done(failed())
        return
      }
      signalGroup(child.pid, 'SIGTERM')
      hardStop = setTimeout(() => {
        signalGroup(child.pid, 'SIGKILL')
        done(failed())
      }, GROUP_STOP_GRACE_MS)
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      detached: options.group ?? false,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    if (options.group && child.pid) groups.add(child.pid)
    const timer = setTimeout(() => abort(`Timed out after ${options.timeoutMs} ms`), options.timeoutMs ?? 120_000)

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      if (failure) return
      stdout += chunk
      if (stdout.length > MAX_OUTPUT_CHARS) abort(`Stopped: more than ${MAX_OUTPUT_CHARS.toLocaleString('en')} characters of output`)
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      if (failure) return
      stderr += chunk
      if (stderr.length > MAX_OUTPUT_CHARS) abort(`Stopped: more than ${MAX_OUTPUT_CHARS.toLocaleString('en')} characters of output`)
    })
    child.on('error', error => done({ code: null, stdout, stderr: error.message }))
    child.on('close', code => done(failure ? failed() : { code, stdout, stderr }))
    // A command that exits before reading its input closes the pipe (EPIPE);
    // its exit code still reports the result, so the write error is noise
    child.stdin.on('error', () => {})
    child.stdin.end(options.input ?? '')
  })
}

// git with the runner's `gh` login as the credential helper for this command
// only, so the user's global git config is never changed
export function git(args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return exec('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args], {
    ...options,
    group: true,
    env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0' }
  })
}

export function gh(args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return exec('gh', args, { ...options, group: true })
}
