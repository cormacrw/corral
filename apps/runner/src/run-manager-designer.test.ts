import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js'
import type { RunJob, RunnerMessage } from '@corral/contracts'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import type { RunnerConfig } from './config.ts'
import type { ServerConnection } from './connection.ts'
import { git } from './exec.ts'
import { ToolServer } from './mcp.ts'
import { RunManager } from './run-manager.ts'
import { createTestDataDir, pmJob } from './test-repo.ts'
import { worktreePath } from './workspace.ts'

// Stands in for `claude`: logs its arguments and stays alive until told to
// exit, so the test can call the run's MCP server the way the agent would
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync, existsSync } = require('node:fs')
appendFileSync(process.env.FAKE_CLAUDE_LOG, JSON.stringify(process.argv.slice(2)) + '\\n')
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 's' }))
setInterval(() => { if (existsSync(process.env.FAKE_CLAUDE_LOG + '.exit')) process.exit(0) }, 20)
`

interface ToolResult {
  isError?: boolean
  content: { text: string }[]
}

describe('RunManager design authoring (D23)', () => {
  let dataDir: string
  let origin: string
  let claudeLog: string
  let sent: RunnerMessage[]
  let manager: RunManager
  let server: ToolServer
  let client: Client | null

  beforeEach(async () => {
    // An agent running these tests has a push URL that always fails
    vi.stubEnv('GIT_CONFIG_COUNT', '0')
    dataDir = await createTestDataDir()
    origin = join(dirname(dataDir), 'origin')
    claudeLog = join(dirname(dataDir), 'claude.log')
    vi.stubEnv('FAKE_CLAUDE_LOG', claudeLog)
    const claudeBin = join(dirname(dataDir), 'claude')
    await writeFile(claudeBin, FAKE_CLAUDE)
    await chmod(claudeBin, 0o755)
    sent = []
    client = null
    server = new ToolServer()
    await server.start()
    const connection = {
      connected: true,
      send: (message: RunnerMessage) => {
        sent.push(message)
        if (message.type !== 'tool.call') return true
        // A pinned job fetches its design first; these tests don't need one
        const result = message.tool === 'get_design' ? { ok: false as const, error: 'No design here' } : { ok: true as const, result: { recorded: message.tool } }
        queueMicrotask(() => manager.handle({ type: 'tool.result', callId: message.callId, ...result }))
        return true
      }
    } as unknown as ServerConnection
    const config: RunnerConfig = { dataDir, claudeBin, codexBin: '/nonexistent/codex', name: 'test', serverUrl: new URL('http://127.0.0.1:9'), gitAuthor: null, pmWarmSeconds: 0, titleModel: 'haiku', slots: 4, roles: ['pm', 'developer', 'reviewer', 'design'] }
    manager = new RunManager(config, connection, server)
  })

  afterEach(async () => {
    await client?.close()
    manager.stop('r1', 'stopped', '')
    // An accepted outcome gets a grace period before the stop signals the agent
    await writeFile(`${claudeLog}.exit`, '')
    await expect.poll(() => sent.some(m => m.type === 'run.ended'), { timeout: 10_000 }).toBe(true)
    void server.close()
    vi.unstubAllEnvs()
    await rm(dirname(dataDir), { recursive: true, force: true })
  })

  const designerJob = pmJob({ runId: 'r1', role: 'designer', leaseEpoch: 1, planSessionId: null, taskId: 'task-1', taskRef: 'APP-1', taskType: 'design', branch: 'design/APP-1', prompt: 'Design it' })
  const developerJob = pmJob({ runId: 'r1', role: 'developer', leaseEpoch: 1, planSessionId: null, taskId: 'task-1', taskRef: 'APP-1', taskType: 'task', branch: 'corral/app-1', prompt: 'Build it' })

  // Assigns the job and connects to its MCP server as the agent would
  async function start(job: RunJob): Promise<Client> {
    manager.assign(job)
    await expect.poll(() => sent.some(m => m.type === 'run.started'), { timeout: 10_000 }).toBe(true)
    const config = JSON.parse(await readFile(join(dataDir, 'scratch', 'r1', 'mcp.json'), 'utf8')) as { mcpServers: { corral: { url: string } } }
    client = new Client({ name: 'test', version: '1' })
    await client.connect(new StreamableHTTPClientTransport(new URL(config.mcpServers.corral.url)))
    return client
  }

  const call = (agent: Client, name: string, args: Record<string, unknown>) => agent.callTool({ name, arguments: args }) as Promise<ToolResult>
  const forwarded = (tool: string) => sent.flatMap(m => m.type === 'tool.call' && m.tool === tool ? [m] : [])

  it('pushes the design branch on submit_design and on design_submitted', async () => {
    const agent = await start(designerJob)
    expect((await agent.listTools()).tools.map(t => t.name)).toContain('submit_design')

    const worktree = worktreePath(dataDir, 'task-1', 'designer')
    await mkdir(join(worktree, 'dist'))
    await writeFile(join(worktree, 'dist', 'index.html'), '<h1>Login</h1>')
    await writeFile(join(worktree, 'design.md'), '# Login\n')
    await writeFile(join(worktree, 'login.png'), 'png')
    await git(['add', '.'], { cwd: worktree })
    expect((await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Prototype'], { cwd: worktree })).code).toBe(0)
    const sha = (await git(['rev-parse', 'HEAD'], { cwd: worktree })).stdout.trim()

    const submitted = await call(agent, 'submit_design', { bundleDir: join(worktree, 'dist'), specPath: join(worktree, 'design.md'), screenshots: [join(worktree, 'login.png')] })
    expect(submitted.isError).toBeFalsy()
    expect(forwarded('submit_design')).toEqual([expect.objectContaining({ input: expect.objectContaining({ headSha: sha, spec: '# Login\n' }) })])
    expect((await git(['rev-parse', 'design/APP-1'], { cwd: origin })).stdout.trim()).toBe(sha)

    const reported = await call(agent, 'report_outcome', { outcome: 'design_submitted', summary: 'Login form', note: 'Built the login prototype' })
    expect(reported.isError).toBeFalsy()
    expect(forwarded('report_outcome')).toEqual([expect.objectContaining({ input: expect.objectContaining({ outcome: 'design_submitted', headSha: sha }) })])
  })

  it.each(['pr_opened', 'pr_updated', 'pr_rebased', 'findings_reported'])('refuses a designer reporting %s, without pushing or telling the server', async (outcome) => {
    const agent = await start(designerJob)
    const refused = await call(agent, 'report_outcome', { outcome, summary: 'Opened a PR', note: 'Opened a PR' })
    expect(refused.isError).toBe(true)
    expect(refused.content[0]!.text).toBe('A designer reports one of: design_submitted, stuck, failed')
    expect(forwarded('report_outcome')).toEqual([])
    expect((await git(['rev-parse', '--verify', '--quiet', 'refs/heads/design/APP-1'], { cwd: origin })).code).not.toBe(0)
  })

  it.each([
    ['a build task', developerJob],
    ['a task pinned to a design', { ...developerJob, designPinned: true } as RunJob],
    ['a design task', { ...developerJob, taskType: 'design' } as RunJob]
  ])('refuses submit_design and design_submitted from a developer on %s', async (_name, job) => {
    const agent = await start(job)
    expect((await agent.listTools()).tools.map(t => t.name)).not.toContain('submit_design')

    const tool = await call(agent, 'submit_design', { bundleDir: '/tmp/dist', specPath: '/tmp/design.md', screenshots: ['/tmp/a.png'] })
    expect(tool.isError).toBe(true)
    expect(tool.content[0]!.text).toBe('The developer can\'t use submit_design: only a designer submits a design')
    expect(forwarded('submit_design')).toEqual([])

    const outcome = await call(agent, 'report_outcome', { outcome: 'design_submitted', summary: 'Done', note: 'Done' })
    expect(outcome.isError).toBe(true)
    expect(outcome.content[0]!.text).toContain('A developer reports one of:')
    expect(forwarded('report_outcome')).toEqual([])
  })

  async function systemPrompt(): Promise<string> {
    const args = JSON.parse((await readFile(claudeLog, 'utf8')).trim().split('\n')[0]!) as string[]
    return args.join('\n')
  }

  it('gives a designer the built-in defaults when the repository has no designer.md', async () => {
    await start(designerJob)
    expect(await systemPrompt()).toContain('You are a designer agent working for Corral')
  })

  it('gives a designer the repository\'s designer.md when it has one', async () => {
    await mkdir(join(origin, '.corral', 'agents'), { recursive: true })
    await writeFile(join(origin, '.corral', 'agents', 'designer.md'), 'Sketch everything in teal.\n')
    await git(['add', '.'], { cwd: origin })
    expect((await git(['-c', 'user.name=Test', '-c', 'user.email=test@example.com', 'commit', '-m', 'Designer rules'], { cwd: origin })).code).toBe(0)

    await start(designerJob)
    const prompt = await systemPrompt()
    expect(prompt).toContain('Sketch everything in teal.')
    expect(prompt).not.toContain('You are a designer agent working for Corral')
  })
})
