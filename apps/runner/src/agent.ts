import { spawn } from 'node:child_process'
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

export function agentArgs(options: Pick<AgentOptions, 'prompt' | 'systemPrompt' | 'mcpConfigPath' | 'model' | 'resumeSessionId'>): string[] {
  const args = [
    '-p', options.prompt,
    '--output-format', 'stream-json',
    '--verbose',
    '--mcp-config', options.mcpConfigPath,
    '--strict-mcp-config',
    '--permission-mode', 'bypassPermissions',
    '--append-system-prompt', options.systemPrompt
  ]
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
  const parser = new StreamJsonParser({ quietResumeOf: options.quietResume ? options.resumeSessionId : null })
  const child = spawn(options.claudeBin, agentArgs(options), {
    cwd: options.cwd,
    env: agentEnv(process.env, options.gitAuthor),
    // Its own process group, so the whole tree can be killed at once
    detached: true,
    stdio: ['ignore', 'pipe', 'pipe']
  })

  // Line by line, never the whole transcript in memory (runner rule 3)
  const stdout = createInterface({ input: child.stdout })
  stdout.on('line', line => options.onLine(line, parser.parse(line)))
  let stderr = ''
  child.stderr.setEncoding('utf8').on('data', (chunk: string) => {
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

  return {
    pid: child.pid ?? -1,
    exited,
    kill(signal) {
      if (!child.pid) return
      try {
        process.kill(-child.pid, signal)
      } catch {
        // The group is already gone
      }
    }
  }
}
