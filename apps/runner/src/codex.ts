import { existsSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { killGroup, startProcess } from './agent.ts'
import type { AgentProcess, AgentRuntime, RuntimeOptions } from './agent-runtime.ts'
import { CodexJsonParser } from './codex-json.ts'
import { MAX_BRIEF_CHARS } from './workspace.ts'

// The Codex AgentRuntime adapter (agent-runtime-and-auth.md). Codex uses the
// login in its own ~/.codex, which Corral never reads or sets (D2). It has no
// streaming session, so a PM follow-up turn is a one-shot resume (D9).

// The registry's entry for runtime id 'codex'
export function codexRuntime(codexBin: string): AgentRuntime {
  return {
    id: 'codex',
    spawn: options => spawnCodex(codexBin, options)
  }
}

export interface McpServerConfig {
  type?: string
  url?: string
  command?: string
  args?: string[]
}

type ArgOptions = Pick<RuntimeOptions, 'prompt' | 'model' | 'resumeSessionId'> & {
  instructions: string
  mcpServers: Record<string, McpServerConfig>
}

// Corral answers a tool call within two minutes, and report_outcome pushes
// first; Codex's own default of 60 s would give up before then
const MCP_TOOL_TIMEOUT_SECONDS = 180

// `codex exec --json`, or `codex exec resume --json … <session>` to resume.
// No approval prompts and no sandbox, like bypassPermissions for Claude: the
// runner (and its container) is the boundary. -c values are TOML.
export function codexArgs(options: ArgOptions): string[] {
  const args = ['exec']
  if (options.resumeSessionId) args.push('resume')
  args.push('--json', '--dangerously-bypass-approvals-and-sandbox')
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
  args.push(options.prompt)
  return args
}

// Codex reads AGENTS.md itself but not CLAUDE.md or CORRAL.md, so a repo
// that only has those gets them in the instructions, as Claude would
const REPO_DOCS = ['CLAUDE.md', 'CORRAL.md', join('.corral', 'CORRAL.md')]

export function codexInstructions(cwd: string, systemPrompt: string): string {
  if (existsSync(join(cwd, 'AGENTS.md'))) return systemPrompt
  const parts = [systemPrompt]
  for (const name of REPO_DOCS) {
    const text = readText(join(cwd, name))?.trim()
    // The PM's project brief may already carry it
    if (!text || systemPrompt.includes(text)) continue
    const body = text.length > MAX_BRIEF_CHARS ? `${text.slice(0, MAX_BRIEF_CHARS)}\n\n[Truncated: read ${name} for the rest.]` : text
    parts.push(`## ${name} (project instructions)\n\n${body}`)
  }
  return parts.join('\n\n')
}

// The run's MCP config file, in the shape Claude's --mcp-config takes
export function readMcpServers(mcpConfigPath: string): Record<string, McpServerConfig> {
  const text = readText(mcpConfigPath)
  if (!text) return {}
  return (JSON.parse(text) as { mcpServers?: Record<string, McpServerConfig> }).mcpServers ?? {}
}

export function spawnCodex(codexBin: string, options: RuntimeOptions): AgentProcess {
  const args = codexArgs({
    prompt: options.prompt,
    model: options.model,
    resumeSessionId: options.resumeSessionId,
    instructions: codexInstructions(options.cwd, options.systemPrompt),
    mcpServers: readMcpServers(options.mcpConfigPath)
  })
  const parser = new CodexJsonParser({ quietResumeOf: options.quietResume ? options.resumeSessionId : null })
  // stdin closed: given a pipe, codex waits to append it to the prompt
  const { child, exited } = startProcess(codexBin, args, 'ignore', options, parser)
  return { pid: child.pid ?? -1, exited, kill: signal => killGroup(child, signal) }
}

function readText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8')
  } catch {
    return null
  }
}

// JSON strings and arrays of strings are valid TOML
function toml(value: string | string[]): string {
  return JSON.stringify(value)
}

function tomlKey(name: string): string {
  return /^[A-Za-z0-9_-]+$/.test(name) ? name : JSON.stringify(name)
}
