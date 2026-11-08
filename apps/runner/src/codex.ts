import { SETUP_STEP_TIMEOUTS } from '@corral/contracts'
import { join } from 'node:path'
import { agentProcess, askOnce, startProcess } from './agent-process.ts'
import type { AgentProcess, AgentRuntime, RuntimeOptions } from './agent-runtime.ts'
import { MCP_TOOL_TIMEOUT_SECONDS } from './budgets.ts'
import { CodexJsonParser } from './codex-json.ts'
import { exec } from './exec.ts'
import { exists, readIfExists } from './layout.ts'
import { MAX_BRIEF_CHARS, PROJECT_DOC_FILES } from './project-docs.ts'

// The Codex AgentRuntime adapter (agent-runtime-and-auth.md). Codex uses the
// login in its own ~/.codex, which Corral never reads or sets (D2). It has no
// streaming session, so a PM follow-up turn is a one-shot resume (D9).

interface CodexConfig {
  bin: string
  // CODEX_HOME, or ~/.codex
  home: string
}

// The registry's entry for runtime id 'codex'
export function codexRuntime(config: CodexConfig): AgentRuntime {
  return {
    id: 'codex',
    skillsDir: join(config.home, 'skills'),
    async prepare(options) {
      return { ...options, systemPrompt: await codexInstructions(options.cwd, options.systemPrompt) }
    },
    spawn: options => spawnCodex(config.bin, options),
    // Never runs `codex login`: the human signs in inside the container (D2)
    async detect() {
      const version = await exec(config.bin, ['--version'], { timeoutMs: SETUP_STEP_TIMEOUTS.cliDetect })
      if (version.code !== 0) return { version: null, signedIn: false }
      const status = await exec(config.bin, ['login', 'status'], { timeoutMs: SETUP_STEP_TIMEOUTS.cliDetect })
      return { version: version.stdout.trim(), signedIn: codexSignedIn(`${status.stdout}\n${status.stderr}`) }
    },
    ask: (prompt, { model, timeoutMs }) => askOnce(config.bin, [
      'exec', '--skip-git-repo-check', '--ephemeral', '--sandbox', 'read-only', ...(model ? ['--model', model] : []), '-'
    ], prompt, timeoutMs)
  }
}

// `codex login status` prints e.g. "Logged in using ChatGPT" (on stderr) or
// "Not logged in". Only the logged-in line counts; the rest says nothing secret.
export function codexSignedIn(output: string): boolean {
  return /^\s*logged in\b/im.test(output)
}

type ArgOptions = Pick<RuntimeOptions, 'model' | 'resumeSessionId' | 'mcpServers'> & {
  noRepository?: boolean
  instructions: string
}

// `codex exec --json`, or `codex exec resume --json … <session>` to resume.
// No approval prompts and no sandbox, like bypassPermissions for Claude: the
// runner (and its container) is the boundary. -c values are TOML. The prompt
// goes on stdin (`-`), since Linux limits one argument to 128 KiB and a
// session reseeded from its history can pass that.
export function codexArgs(options: ArgOptions): string[] {
  const args = ['exec']
  if (options.resumeSessionId) args.push('resume')
  args.push('--json', '--dangerously-bypass-approvals-and-sandbox')
  // A global PM session runs in a plain folder, and Codex refuses that otherwise
  if (options.noRepository) args.push('--skip-git-repo-check')
  for (const [name, server] of Object.entries(options.mcpServers)) {
    const key = `mcp_servers.${tomlKey(name)}`
    if (server.url) args.push('-c', `${key}.url=${toml(server.url)}`)
    if (server.command) args.push('-c', `${key}.command=${toml(server.command)}`)
    if (server.args) args.push('-c', `${key}.args=${toml(server.args)}`)
    args.push('-c', `${key}.tool_timeout_sec=${MCP_TOOL_TIMEOUT_SECONDS}`)
  }
  args.push('-c', `developer_instructions=${toml(options.instructions)}`)
  if (options.model) args.push('--model', options.model)
  args.push('--')
  if (options.resumeSessionId) args.push(options.resumeSessionId)
  args.push('-')
  return args
}

// Codex reads AGENTS.md itself but not the other project docs, so a repo
// that only has those gets them in the instructions, as Claude would
export async function codexInstructions(cwd: string, systemPrompt: string): Promise<string> {
  if (await exists(join(cwd, 'AGENTS.md'))) return systemPrompt
  const parts = [systemPrompt]
  for (const name of PROJECT_DOC_FILES) {
    const text = (await readIfExists(join(cwd, name)))?.trim()
    // The PM's project brief may already carry it
    if (!text || systemPrompt.includes(text)) continue
    const body = text.length > MAX_BRIEF_CHARS ? `${text.slice(0, MAX_BRIEF_CHARS)}\n\n[Truncated: read ${name} for the rest.]` : text
    parts.push(`## ${name} (project instructions)\n\n${body}`)
  }
  return parts.join('\n\n')
}

function spawnCodex(bin: string, options: RuntimeOptions): AgentProcess {
  const args = codexArgs({
    model: options.model,
    resumeSessionId: options.resumeSessionId,
    noRepository: options.noRepository,
    instructions: options.systemPrompt,
    mcpServers: options.mcpServers
  })
  const parser = new CodexJsonParser({ quietResumeOf: options.quietResume ? options.resumeSessionId : null })
  const { child, exited } = startProcess({ bin, args, stdin: 'pipe', input: options.prompt, envToStrip: [], parser }, options)
  return agentProcess(child, exited)
}

// JSON strings and arrays of strings are valid TOML
function toml(value: string | string[]): string {
  return JSON.stringify(value)
}

function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)
}
