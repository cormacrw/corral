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
}

// Runs a command without blocking the event loop (architecture.md, runner
// rule 1) and without a shell. Never throws: a missing binary is code null.
export function exec(command: string, args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return new Promise((resolve) => {
    let stdout = ''
    let stderr = ''
    let settled = false
    const done = (result: ExecResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(result)
    }

    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env ?? process.env,
      stdio: ['pipe', 'pipe', 'pipe']
    })
    const timer = setTimeout(() => {
      child.kill('SIGKILL')
      done({ code: null, stdout, stderr: `${stderr}\nTimed out after ${options.timeoutMs} ms` })
    }, options.timeoutMs ?? 120_000)

    child.stdout.setEncoding('utf8').on('data', (chunk: string) => {
      stdout += chunk
    })
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
      stderr += chunk
    })
    child.on('error', error => done({ code: null, stdout, stderr: error.message }))
    child.on('close', code => done({ code, stdout, stderr }))
    child.stdin.end(options.input ?? '')
  })
}

// git with the runner's `gh` login as the credential helper for this command
// only, so the user's global git config is never changed
export function git(args: string[], options: ExecOptions = {}): Promise<ExecResult> {
  return exec('git', ['-c', 'credential.helper=', '-c', 'credential.helper=!gh auth git-credential', ...args], {
    ...options,
    env: { ...process.env, ...options.env, GIT_TERMINAL_PROMPT: '0' }
  })
}
