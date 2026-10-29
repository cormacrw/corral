import type { RunnerMessage } from '@corral/contracts'
import { chmod, mkdir, readFile, rm, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerConnection } from './connection.ts'
import type { ToolServer } from './mcp.ts'
import { RunManager } from './run-manager.ts'
import { DEFAULT_ROLE_INSTRUCTIONS } from './role-defaults.ts'
import { createTestDataDir, pmJob, TEST_REPOSITORY } from './test-repo.ts'
import { exec } from './exec.ts'
import { barePath } from './repos.ts'
import { pmWorktreePath } from './workspace.ts'

// Stands in for `claude`: logs how it was called, fails a --resume of any
// session it doesn't know (as the CLI does for a session made in another
// directory), and otherwise starts session "fresh-session"
const FAKE_CLAUDE = `#!/usr/bin/env node
const { appendFileSync } = require('node:fs')
const args = process.argv.slice(2)
appendFileSync(process.env.FAKE_CLAUDE_LOG || __filename + '.log', JSON.stringify({ args, cwd: process.cwd() }) + '\\n')
const resume = args[args.indexOf('--resume') + 1]
if (args.includes('--resume') && resume !== 'fresh-session') {
  console.error('No conversation found with session ID: ' + resume)
  process.exit(1)
}
console.log(JSON.stringify({ type: 'system', subtype: 'init', session_id: 'fresh-session' }))
console.log(JSON.stringify({ type: 'result', subtype: 'success', is_error: false, result: 'Done', session_id: 'fresh-session' }))
`

describe('RunManager PM turns', () => {
  let dataDir: string
  let claudeBin: string
  let sent: RunnerMessage[]
  let manager: RunManager

  beforeEach(async () => {
    dataDir = await createTestDataDir()
    claudeBin = join(dirname(dataDir), 'claude')
    await writeFile(claudeBin, FAKE_CLAUDE)
    await chmod(claudeBin, 0o755)
    sent = []
    const connection = { send: (message: RunnerMessage) => sent.push(message) > 0 } as unknown as ServerConnection
    const tools = { register: () => () => {}, url: () => 'http://127.0.0.1:9/mcp' } as unknown as ToolServer
    manager = new RunManager({ dataDir, claudeBin, name: 'test', serverUrl: new URL('http://127.0.0.1:9') }, connection, tools)
  })

  afterEach(async () => {
    await rm(dirname(dataDir), { recursive: true, force: true })
  })

  async function finish(runId: string) {
    await expect.poll(() => sent.find(m => m.type === 'run.ended' && m.runId === runId), { timeout: 10_000 }).toBeTruthy()
    return sent.filter(m => 'runId' in m && m.runId === runId)
  }

  async function calls(): Promise<{ args: string[], cwd: string }[]> {
    const log = await readFile(`${claudeBin}.log`, 'utf8')
    return log.trim().split('\n').map(line => JSON.parse(line) as { args: string[], cwd: string })
  }

  it('falls back to a summary-seeded fresh start when a pre-existing session cannot be resumed', async () => {
    manager.assign(pmJob({ runId: 'r1', agentSessionId: 'made-in-the-old-checkout', prompt: 'Next message', fallbackPrompt: 'Summary of the conversation' }))
    const messages = await finish('r1')

    expect(messages.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
    expect(messages.find(m => m.type === 'run.started')).toMatchObject({ agentSessionId: 'fresh-session' })
    const [resume, fresh] = await calls()
    expect(resume!.args).toEqual(expect.arrayContaining(['--resume', 'made-in-the-old-checkout', '-p', 'Next message']))
    expect(fresh!.args).not.toContain('--resume')
    expect(fresh!.args).toEqual(expect.arrayContaining(['-p', 'Summary of the conversation']))
    const notes = messages.flatMap(m => m.type === 'run.events' ? m.events : []).map(e => e.type === 'system' ? e.text : '')
    expect(notes).toContain('The previous agent session could not be resumed; starting a fresh one from the saved conversation')
  })

  it('runs every turn of a session in the same checkout, so the next turn resumes', async () => {
    manager.assign(pmJob({ runId: 'r1', planSessionId: 's1' }))
    await finish('r1')
    manager.assign(pmJob({ runId: 'r2', planSessionId: 's1', agentSessionId: 'fresh-session', fallbackPrompt: 'Summary' }))
    const messages = await finish('r2')

    expect(messages.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
    const log = await calls()
    expect(log).toHaveLength(2)
    expect(log.map(c => c.cwd)).toEqual([pmWorktreePath(dataDir, 'project-1', 's1'), pmWorktreePath(dataDir, 'project-1', 's1')])
    expect(log[1]!.args).toEqual(expect.arrayContaining(['--resume', 'fresh-session']))
  })

  // Commits files to the origin the bare clone fetches from
  async function commitToOrigin(files: Record<string, string>): Promise<string> {
    const origin = join(dirname(dataDir), 'origin')
    for (const [path, text] of Object.entries(files)) {
      await mkdir(join(origin, dirname(path)), { recursive: true })
      await writeFile(join(origin, path), text)
    }
    const git = (args: string[]) => exec('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.com', ...args], { cwd: origin })
    await git(['add', '.'])
    await git(['commit', '--quiet', '-m', 'Docs'])
    return (await git(['rev-parse', 'HEAD'])).stdout.trim()
  }

  function systemPrompt(call: { args: string[] }): string {
    return call.args[call.args.indexOf('--append-system-prompt') + 1]!
  }

  it('puts the project brief in the PM system prompt', async () => {
    await commitToOrigin({ 'CORRAL.md': '# Acme brief\n', '.corral/wiki/setup.md': 'Setup' })
    manager.assign(pmJob({ runId: 'r1' }))
    await finish('r1')

    const prompt = systemPrompt((await calls())[0]!)
    expect(prompt).toContain(`${DEFAULT_ROLE_INSTRUCTIONS.pm}\n\n## Project brief\n`)
    expect(prompt).toContain('### CORRAL.md\n\n# Acme brief')
    expect(prompt).toContain('- setup.md')
    expect(prompt).toMatch(/\n\n## Corral runner notes\n/)
  })

  it('starts a PM run with no brief section when the repo has no brief files', async () => {
    manager.assign(pmJob({ runId: 'r1' }))
    const messages = await finish('r1')

    expect(messages.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
    const prompt = systemPrompt((await calls())[0]!)
    expect(prompt).not.toContain('## Project brief')
    expect(prompt).toMatch(new RegExp(`^${escape(DEFAULT_ROLE_INSTRUCTIONS.pm)}\\n\\n## Corral runner notes\\n`))
  })

  it.each(['developer', 'reviewer'] as const)('leaves the %s system prompt without a brief', async (role) => {
    const sha = await commitToOrigin({ 'CORRAL.md': '# Acme brief\n', '.corral/wiki/setup.md': 'Setup' })
    if (role === 'reviewer') {
      await exec('git', ['fetch', '--quiet', 'origin'], { cwd: barePath(dataDir, TEST_REPOSITORY) })
    }
    manager.assign(pmJob({ runId: 'r1', role, planSessionId: null, taskId: 'task-1', taskRef: 'APP-1', branch: 'corral/app-1', headSha: role === 'reviewer' ? sha : null }))
    await finish('r1')

    const prompt = systemPrompt((await calls())[0]!)
    expect(prompt).toMatch(new RegExp(`^${escape(DEFAULT_ROLE_INSTRUCTIONS[role]!)}\\n\\n## Corral runner notes\\n`))
    expect(prompt).not.toContain('Project brief')
    expect(prompt).not.toContain('Acme brief')
  })
})

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
