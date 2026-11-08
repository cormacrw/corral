import { SETUP_STEP_TIMEOUTS } from '@corral/contracts'
import { runtimeOfCli } from '@corral/core'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { agentProcess, askOnce, startProcess } from './agent-process.ts'
import type { AgentProcess, AgentRuntime, AgentSession, RuntimeOptions, SessionOptions, TurnResult } from './agent-runtime.ts'
import { exec } from './exec.ts'
import { StreamJsonParser } from './stream-json.ts'

// The Claude Code AgentRuntime adapter (agent-runtime-and-auth.md). Auth is
// the CLI's own business: it reads its login from the user's config and
// Corral never sees it (D2).

interface ClaudeConfig {
  bin: string
  // CLAUDE_CONFIG_DIR, or ~/.claude
  configDir: string
}

// A runner started from inside Claude Code would otherwise make every agent
// think it is nested in one
const ENV_TO_STRIP = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT']

// The registry's entry for runtime id 'claude-code'
export function claudeCodeRuntime(config: ClaudeConfig): AgentRuntime {
  return {
    id: runtimeOfCli('claude'),
    skillsDir: join(config.configDir, 'skills'),
    // --mcp-config takes a file
    async prepare(options) {
      await writeFile(mcpConfigPath(options.scratchDir), JSON.stringify({ mcpServers: options.mcpServers }))
      return options
    },
    spawn: options => spawnAgent(config.bin, options),
    spawnSession: options => spawnAgentSession(config.bin, options),
    async detect() {
      const version = await exec(config.bin, ['--version'], { timeoutMs: SETUP_STEP_TIMEOUTS.cliDetect })
      // Only the exit code is used: Corral never reads the login itself (D2)
      const auth = version.code === 0 ? await exec(config.bin, ['auth', 'status'], { timeoutMs: SETUP_STEP_TIMEOUTS.cliDetect }) : null
      return { version: version.code === 0 ? version.stdout.trim() : null, signedIn: auth?.code === 0 }
    },
    ask: (prompt, { model, timeoutMs }) => askOnce(config.bin, [
      '-p', ...(model ? ['--model', model] : []), '--tools', '', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'text'
    ], prompt, timeoutMs)
  }
}

function mcpConfigPath(scratchDir: string): string {
  return join(scratchDir, 'mcp.json')
}

type ArgOptions = Pick<SessionOptions, 'systemPrompt' | 'model' | 'resumeSessionId'> & { mcpConfigPath: string }

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

export function spawnAgent(bin: string, options: RuntimeOptions): AgentProcess {
  const { child, exited } = startAgent(bin, agentArgs({ ...options, mcpConfigPath: mcpConfigPath(options.scratchDir) }), 'ignore', options)
  return agentProcess(child, exited)
}

// A long-lived agent that takes turns over stdin: each send() is one user
// message, and each turn ends with a result line. onLine still sees every line.
// A message() can join the turn under way, which then ends with one result
// for both, so each result records whether the CLI had taken in every
// message by then (its replay of the message came first). An empty result
// ahead of a sent prompt's replay answers nothing we sent, so it's no turn:
// taken for one, it would close stdin on the turn that's just starting.
export function spawnAgentSession(bin: string, options: SessionOptions): AgentSession {
  const results: Turn[] = []
  const waiting: ((turn: Turn | null) => void)[] = []
  const unreplayed: string[] = []
  const unreplayedPrompts: string[] = []
  let ended = false
  const { child, exited, parser } = startAgent(bin, agentArgs({ systemPrompt: options.systemPrompt, model: options.model, resumeSessionId: options.resumeSessionId, mcpConfigPath: mcpConfigPath(options.scratchDir), input: 'stream-json' }), 'pipe', {
    ...options,
    onLine(raw, parsed) {
      options.onLine(raw, parsed)
      if (parsed.replayed !== undefined) {
        for (const list of [unreplayed, unreplayedPrompts]) {
          const index = list.indexOf(parsed.replayed)
          if (index >= 0) list.splice(index, 1)
        }
      }
      if (!parsed.result || (parsed.emptyTurn && unreplayedPrompts.length > 0)) return
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
      unreplayedPrompts.push(prompt)
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

function startAgent(bin: string, args: string[], stdin: 'ignore' | 'pipe', options: SessionOptions) {
  const parser = new StreamJsonParser({ quietResumeOf: options.quietResume ? options.resumeSessionId : null })
  return { ...startProcess({ bin, args, stdin, envToStrip: ENV_TO_STRIP, parser }, options), parser }
}
