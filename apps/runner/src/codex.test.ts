import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { codexArgs, codexInstructions, readMcpServers } from './codex.ts'

const corral = { corral: { type: 'http', url: 'http://127.0.0.1:4321/runs/secret' } }

describe('codexArgs', () => {
  it('runs exec headless with JSON output, the MCP server and the instructions', () => {
    const args = codexArgs({ prompt: 'Do the task', model: null, resumeSessionId: null, instructions: 'Be "careful"\nand quick', mcpServers: corral })
    expect(args).toEqual([
      'exec', '--json', '--dangerously-bypass-approvals-and-sandbox',
      '-c', 'mcp_servers.corral.url="http://127.0.0.1:4321/runs/secret"',
      '-c', 'mcp_servers.corral.tool_timeout_sec=180',
      '-c', 'developer_instructions="Be \\"careful\\"\\nand quick"',
      '--', 'Do the task'
    ])
    expect(args).not.toContain('--model')
  })

  it('passes the model when set', () => {
    const args = codexArgs({ prompt: 'Go', model: 'gpt-5.5-codex', resumeSessionId: null, instructions: '', mcpServers: corral })
    expect(args.slice(args.indexOf('--model'), args.indexOf('--model') + 2)).toEqual(['--model', 'gpt-5.5-codex'])
    expect(args.indexOf('--model')).toBeLessThan(args.indexOf('--'))
  })

  it('resumes with the resume subcommand and the session before the prompt', () => {
    const args = codexArgs({ prompt: 'Report now', model: null, resumeSessionId: 'thread-1', instructions: 'x', mcpServers: corral })
    expect(args.slice(0, 2)).toEqual(['exec', 'resume'])
    expect(args.slice(-3)).toEqual(['--', 'thread-1', 'Report now'])
    // Config isn't kept with the session, so a resume gets the tools again
    expect(args).toContain('mcp_servers.corral.url="http://127.0.0.1:4321/runs/secret"')
  })

  it('passes a stdio MCP server as command and args', () => {
    const args = codexArgs({ prompt: 'Go', model: null, resumeSessionId: null, instructions: '', mcpServers: { 'my tools': { command: 'node', args: ['server.js'] } } })
    expect(args).toContain('mcp_servers."my tools".command="node"')
    expect(args).toContain('mcp_servers."my tools".args=["server.js"]')
  })
})

describe('codex instructions and MCP config', () => {
  let dir: string

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'corral-codex-'))
  })

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true })
  })

  it('adds CLAUDE.md when the repo has no AGENTS.md', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# House rules\nUse pnpm.\n')
    const instructions = codexInstructions(dir, 'Role instructions\n\n## Corral runner notes')
    expect(instructions).toMatch(/^Role instructions\n\n## Corral runner notes/)
    expect(instructions).toContain('## CLAUDE.md (project instructions)\n\n# House rules\nUse pnpm.')
  })

  it('adds CORRAL.md and .corral/CORRAL.md too', async () => {
    await writeFile(join(dir, 'CORRAL.md'), 'Root brief')
    await mkdir(join(dir, '.corral'))
    await writeFile(join(dir, '.corral', 'CORRAL.md'), 'Nested brief')
    const instructions = codexInstructions(dir, 'Role')
    expect(instructions).toContain('## CORRAL.md (project instructions)\n\nRoot brief')
    expect(instructions).toContain('## .corral/CORRAL.md (project instructions)\n\nNested brief')
  })

  it('leaves them out when there is an AGENTS.md, which Codex reads itself', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# House rules')
    await writeFile(join(dir, 'AGENTS.md'), '# Agent rules')
    expect(codexInstructions(dir, 'Role')).toBe('Role')
  })

  it('does not repeat a file the system prompt already carries', async () => {
    await writeFile(join(dir, 'CLAUDE.md'), '# House rules\n')
    expect(codexInstructions(dir, 'Role\n\n### CLAUDE.md\n\n# House rules')).toBe('Role\n\n### CLAUDE.md\n\n# House rules')
  })

  it('reads the servers from the run\'s MCP config', async () => {
    const path = join(dir, 'mcp.json')
    await writeFile(path, JSON.stringify({ mcpServers: corral }))
    expect(readMcpServers(path)).toEqual(corral)
    expect(readMcpServers(join(dir, 'missing.json'))).toEqual({})
  })
})
