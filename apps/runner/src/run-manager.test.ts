import type { RunnerMessage } from '@corral/contracts'
import { chmod, mkdir, readdir, readFile, rm, stat, symlink, truncate, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { ServerConnection } from './connection.ts'
import type { ToolHandler, ToolServer } from './mcp.ts'
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
  let handler: ToolHandler | undefined

  beforeEach(async () => {
    dataDir = await createTestDataDir()
    claudeBin = join(dirname(dataDir), 'claude')
    await writeFile(claudeBin, FAKE_CLAUDE)
    await chmod(claudeBin, 0o755)
    sent = []
    const connection = { send: (message: RunnerMessage) => sent.push(message) > 0 } as unknown as ServerConnection
    const tools = { register: (_secret: string, _role: string, call: ToolHandler) => {
      handler = call
      return () => {}
    }, url: () => 'http://127.0.0.1:9/mcp' } as unknown as ToolServer
    manager = new RunManager({ dataDir, claudeBin, codexBin: 'codex', name: 'test', serverUrl: new URL('http://127.0.0.1:9'), gitAuthor: null, pmWarmSeconds: 0, titleModel: 'haiku', slots: 4, roles: ['pm', 'developer', 'reviewer', 'design'] }, connection, tools)
  })

  afterEach(async () => {
    await manager.shutdown()
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

  function notes(messages: RunnerMessage[]): string[] {
    return messages.flatMap(m => m.type === 'run.events' ? m.events : []).flatMap(e => e.type === 'system' ? [e.text] : [])
  }

  it.each(['pm', 'developer'] as const)('checks scratch paths and size for %s evidence', async (role) => {
    await writeFile(claudeBin, '#!/bin/sh\nsleep 600\n')
    handler = undefined
    manager.assign(pmJob({ runId: 'r1', role, ...(role === 'developer' && { planSessionId: null, taskId: 'task-1', taskRef: 'APP-1', branch: 'corral/app-1' }) }))
    await expect.poll(() => handler).toBeDefined()
    const scratch = join(dataDir, 'scratch', 'r1')
    const outside = join(dataDir, 'outside.txt')
    await writeFile(outside, 'private')
    await symlink(outside, join(scratch, 'escape.txt'))
    for (const path of [outside, '../../outside.txt', 'escape.txt']) {
      expect(await handler!('attach_evidence', { kind: 'text', path })).toEqual({ ok: false, error: 'Evidence files must be inside your scratch directory' })
    }
    const large = join(scratch, 'large.txt')
    await writeFile(large, '')
    await truncate(large, 25 * 1024 * 1024 + 1)
    expect(await handler!('attach_evidence', { kind: 'text', path: large })).toEqual({ ok: false, error: 'Evidence files are limited to 25 MB' })
    expect(sent.some(m => m.type === 'tool.call')).toBe(false)
    const allowed = join(scratch, 'notes.txt')
    await writeFile(allowed, 'PM notes')
    for (const path of ['notes.txt', allowed]) {
      const attaching = handler!('attach_evidence', { kind: 'text', path })
      await expect.poll(() => sent.find(m => m.type === 'tool.call')).toBeDefined()
      const index = sent.findIndex(m => m.type === 'tool.call')
      const call = sent.splice(index, 1)[0]!
      if (call.type !== 'tool.call') throw new Error('Expected an upload')
      expect(call.input).toMatchObject({ fileName: 'notes.txt', contentType: 'text/plain', dataBase64: Buffer.from('PM notes').toString('base64') })
      manager.handle({ type: 'tool.result', callId: call.callId, ok: true, result: { id: 'saved' } })
      expect(await attaching).toEqual({ ok: true, result: { id: 'saved' } })
    }
  })

  it('runs global PM turns without a checkout and explains how to read code', async () => {
    manager.assign(pmJob({ runId: 'global', projectId: null, repository: '', defaultBranch: '', planSessionId: 'global-thread' }))
    await finish('global')
    const [call] = await calls()
    expect(call!.cwd).toBe(join(dataDir, 'sessions', 'global-thread'))
    const gitStatus = await exec('git', ['rev-parse', '--is-inside-work-tree'], { cwd: call!.cwd })
    expect(gitStatus.code).not.toBe(0)
    const prompt = call!.args[call!.args.indexOf('--append-system-prompt') + 1]
    expect(prompt).toContain('no repository checkout or worktree')
    expect(prompt).toContain('Start a project thread when you need to read code')
    if (process.env.CORRAL_GLOBAL_RUNNER_EVIDENCE) await writeFile(process.env.CORRAL_GLOBAL_RUNNER_EVIDENCE, JSON.stringify({ job: { role: 'pm', projectId: null, repository: '', defaultBranch: '' }, launchedProcess: call, directoryEntries: await readdir(call!.cwd), gitStatus, runnerMessages: sent }, null, 2))
  })

  it('shows the worktree and session start notes on the first turn of a session', async () => {
    manager.assign(pmJob({ runId: 'r1', planSessionId: 's1' }))
    const shown = notes(await finish('r1'))

    expect(shown.some(n => n.startsWith('Preparing a worktree'))).toBe(true)
    expect(shown).toContain('Session started')
  })

  it('hides the worktree and session start notes on a follow-up turn that resumes', async () => {
    manager.assign(pmJob({ runId: 'r1', planSessionId: 's1' }))
    await finish('r1')
    manager.assign(pmJob({ runId: 'r2', planSessionId: 's1', agentSessionId: 'fresh-session', fallbackPrompt: 'Summary' }))
    const shown = notes(await finish('r2'))

    expect(shown.some(n => n.startsWith('Preparing a worktree'))).toBe(false)
    expect(shown).not.toContain('Session started')
    expect((await calls())[1]!.args).toEqual(expect.arrayContaining(['--resume', 'fresh-session']))
  })

  it.each(['developer', 'reviewer'] as const)('keeps the worktree and session start notes for a %s run', async (role) => {
    const sha = await commitToOrigin({ 'README.md': 'Hello\n' })
    if (role === 'reviewer') {
      await exec('git', ['fetch', '--quiet', 'origin'], { cwd: barePath(dataDir, TEST_REPOSITORY) })
    }
    manager.assign(pmJob({ runId: 'r1', role, planSessionId: null, taskId: 'task-1', taskRef: 'APP-1', branch: 'corral/app-1', headSha: role === 'reviewer' ? sha : null }))
    const shown = notes(await finish('r1'))

    expect(shown).toContain('Preparing a worktree for acme/app on corral/app-1')
    expect(shown).toContain('Session started')
  })

  it('falls back to a summary-seeded fresh start when a pre-existing session cannot be resumed', async () => {
    manager.assign(pmJob({ runId: 'r1', agentSessionId: 'made-in-the-old-checkout', prompt: 'Next message', fallbackPrompt: 'Summary of the conversation' }))
    const messages = await finish('r1')

    expect(messages.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
    expect(messages.find(m => m.type === 'run.started')).toMatchObject({ agentSessionId: 'fresh-session' })
    const [resume, fresh] = await calls()
    expect(resume!.args).toEqual(expect.arrayContaining(['--resume', 'made-in-the-old-checkout', '-p', 'Next message']))
    expect(fresh!.args).not.toContain('--resume')
    expect(fresh!.args).toEqual(expect.arrayContaining(['-p', 'Summary of the conversation']))
    const shown = notes(messages)
    expect(shown).toContain('The previous agent session could not be resumed; starting a fresh one from the saved conversation')
    // The fresh session is new to the transcript, so it says so
    expect(shown).toContain('Session started')
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

  it('includes worktree status when the repo has no brief files', async () => {
    manager.assign(pmJob({ runId: 'r1' }))
    const messages = await finish('r1')

    expect(messages.find(m => m.type === 'run.ended')).toMatchObject({ exit: { kind: 'exited', code: 0 } })
    const prompt = systemPrompt((await calls())[0]!)
    expect(prompt).toContain('.corral/wiki/ does not exist; dependencies (node_modules) are not installed in this worktree.')
    expect(prompt).toMatch(new RegExp(`^${escape(DEFAULT_ROLE_INSTRUCTIONS.pm)}\\n\\n## Project brief\\n`))
  })

  // D20: a build task's runs get the pinned design before the agent starts
  it.each(['developer', 'reviewer'] as const)('saves the pinned design read-only outside the worktree for a %s run', async (role) => {
    const sha = await commitToOrigin({ 'README.md': 'Hello\n' })
    if (role === 'reviewer') await exec('git', ['fetch', '--quiet', 'origin'], { cwd: barePath(dataDir, TEST_REPOSITORY) })
    const src = join(dirname(dataDir), 'bundle-src')
    await mkdir(src, { recursive: true })
    await writeFile(join(src, 'index.html'), '<h1>Login</h1>')
    await exec('tar', ['-cf', join(dirname(dataDir), 'bundle.tar'), '-C', src, '.'])
    const bundle = (await readFile(join(dirname(dataDir), 'bundle.tar'))).toString('base64')
    const asked: unknown[] = []
    // The server answers get_design with the pinned version
    const send = (message: RunnerMessage) => {
      sent.push(message)
      if (message.type === 'tool.call' && message.tool === 'get_design') {
        asked.push(message.input)
        queueMicrotask(() => manager.handle({ type: 'tool.result', callId: message.callId, ok: true, result: {
          taskRef: 'APP-1', title: 'Login', version: 1, status: 'approved', branch: 'design/APP-1', commitSha: 'd1', spec: '# Login', pinnedScreens: ['login'],
          screenshots: [{ fileName: 'login.png', contentType: 'image/png', dataBase64: Buffer.from('png').toString('base64') }], bundle: { dataBase64: bundle }
        } }))
      }
      return true
    }
    const tools = { register: () => () => {}, url: () => 'http://127.0.0.1:9/mcp' } as unknown as ToolServer
    manager = new RunManager({ dataDir, claudeBin, codexBin: 'codex', name: 'test', serverUrl: new URL('http://127.0.0.1:9'), gitAuthor: null, pmWarmSeconds: 0, titleModel: 'haiku', slots: 4, roles: ['pm', 'developer', 'reviewer', 'design'] }, { send } as unknown as ServerConnection, tools)
    manager.assign(pmJob({ runId: 'r1', role, planSessionId: null, taskId: 'task-2', taskRef: 'APP-2', designPinned: true, branch: 'corral/app-2', headSha: role === 'reviewer' ? sha : null }))
    await finish('r1')

    expect(asked).toEqual([{ taskRef: 'APP-2' }])
    const call = (await calls())[0]!
    const dir = join(dataDir, 'scratch', 'r1', 'designs', 'APP-1-v1')
    expect(systemPrompt(call)).toContain(`The pinned design, v1 of APP-1, is saved read-only in ${dir}, outside the repository`)
    expect(systemPrompt(call)).toContain('built on branch design/APP-1, for reference only')
    expect(await readFile(join(dir, 'design.md'), 'utf8')).toBe('# Login')
    expect(await readFile(join(dir, 'bundle', 'index.html'), 'utf8')).toBe('<h1>Login</h1>')
    expect((await stat(join(dir, 'design.md'))).mode & 0o222).toBe(0)
    // Not in the worktree the agent works in
    expect(dir.startsWith(call.cwd)).toBe(false)
    expect(await exec('git', ['status', '--porcelain'], { cwd: call.cwd })).toMatchObject({ stdout: '' })
    await exec('chmod', ['-R', 'u+w', dirname(dataDir)])
  })

  it.each([
    { role: 'developer', wiki: true }, { role: 'reviewer', wiki: true },
    { role: 'developer', wiki: false }, { role: 'reviewer', wiki: false }
  ] as const)('includes the shared brief for $role with wiki=$wiki', async ({ role, wiki }) => {
    const files: Record<string, string> = { 'CORRAL.md': '# Acme brief\n' }
    if (wiki) files['.corral/wiki/setup.md'] = 'Setup'
    const sha = await commitToOrigin(files)
    if (role === 'reviewer') {
      await exec('git', ['fetch', '--quiet', 'origin'], { cwd: barePath(dataDir, TEST_REPOSITORY) })
    }
    manager.assign(pmJob({ runId: 'r1', role, planSessionId: null, taskId: 'task-1', taskRef: 'APP-1', branch: 'corral/app-1', headSha: role === 'reviewer' ? sha : null }))
    await finish('r1')

    const prompt = systemPrompt((await calls())[0]!)
    expect(prompt).toMatch(new RegExp(`^${escape(DEFAULT_ROLE_INSTRUCTIONS[role]!)}\\n\\n## Project brief\\n`))
    expect(prompt).toContain(wiki ? '.corral/wiki/ exists' : '.corral/wiki/ does not exist')
    expect(prompt).toContain('### CORRAL.md\n\n# Acme brief')
    expect(prompt).toContain('dependencies (node_modules) are not installed in this worktree.')
    if (wiki) expect(prompt).toContain('- setup.md')
  })
})

function escape(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}
