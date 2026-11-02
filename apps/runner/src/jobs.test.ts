import { chmod, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig, type RunnerConfig } from './config.ts'
import { MAX_OUTPUT_CHARS } from './exec.ts'
import { codexSignedIn, githubLog, githubRequest, parseIncludedResponse, runSetupJob, signedInRuntimes, toRepoSummary } from './jobs.ts'

describe('detect_clis', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'corral-detect-clis-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function fakeCli(name: string, script: string): Promise<string> {
    const path = join(root, name)
    await writeFile(path, `#!/bin/sh\n${script}\n`)
    await chmod(path, 0o755)
    return path
  }

  async function countedCli(name: string, signedIn: boolean): Promise<string> {
    return fakeCli(name, `echo run >> '${join(root, 'runs')}'; echo 'Logged in'; exit ${signedIn ? 0 : 1}`)
  }
  const runs = async () => (await readFile(join(root, 'runs'), 'utf8')).split('\n').filter(Boolean).length

  it('runs one detection for a hello and the server\'s check right after it', async () => {
    const config = { claudeBin: await countedCli('claude', true), codexBin: await fakeCli('codex', `echo run >> '${join(root, 'runs')}'; echo 'Logged in'`) } as RunnerConfig
    const [first, second] = await Promise.all([signedInRuntimes(config), runSetupJob(config, { kind: 'detect_clis' })])
    const counted = await runs()
    await signedInRuntimes(config)

    expect(first).toEqual(['claude-code', 'codex'])
    expect(second.kind).toBe('detect_clis')
    expect(counted).toBe(4)
    expect(await runs()).toBe(4)
  })

  it('checks again each time while a CLI is signed out, so a new login shows up', async () => {
    const config = { claudeBin: await countedCli('claude', false), codexBin: join(root, 'missing') } as RunnerConfig
    await signedInRuntimes(config)
    const counted = await runs()
    await signedInRuntimes(config)
    expect(await runs()).toBeGreaterThan(counted)
  })

  it('reports claude and codex, and a missing codex as not found without failing', async () => {
    const claudeBin = await fakeCli('claude', 'if [ "$1" = "--version" ]; then echo "2.1.312 (Claude Code)"; fi; exit 0')
    const config = { ...loadConfig({}), claudeBin, codexBin: join(root, 'no-such-codex') }
    expect(await runSetupJob(config, { kind: 'detect_clis' })).toEqual({
      kind: 'detect_clis',
      clis: [
        { id: 'claude', version: '2.1.312 (Claude Code)', signedIn: true },
        { id: 'codex', version: null, signedIn: false }
      ]
    })
  })

  it('reads the codex version and its login from stderr', async () => {
    const codexBin = await fakeCli('codex', 'if [ "$1" = "--version" ]; then echo "codex-cli 0.165.0"; else echo "Logged in using ChatGPT" >&2; fi')
    const config = { ...loadConfig({}), claudeBin: join(root, 'no-such-claude'), codexBin }
    const result = await runSetupJob(config, { kind: 'detect_clis' })
    expect(result).toEqual({
      kind: 'detect_clis',
      clis: [
        { id: 'claude', version: null, signedIn: false },
        { id: 'codex', version: 'codex-cli 0.165.0', signedIn: true }
      ]
    })
  })

  it('reports an installed codex that is not signed in', async () => {
    const codexBin = await fakeCli('codex', 'if [ "$1" = "--version" ]; then echo "codex-cli 0.165.0"; else echo "Not logged in" >&2; exit 1; fi')
    const config = { ...loadConfig({}), claudeBin: join(root, 'no-such-claude'), codexBin }
    const result = await runSetupJob(config, { kind: 'detect_clis' })
    expect(result.kind === 'detect_clis' && result.clis[1]).toEqual({ id: 'codex', version: 'codex-cli 0.165.0', signedIn: false })
  })
})

describe('codexSignedIn', () => {
  it('is true when `codex login status` says it is logged in', () => {
    expect(codexSignedIn('Logged in using ChatGPT')).toBe(true)
    expect(codexSignedIn('Logged in using an API key - sk-proj-***ABCD\n')).toBe(true)
  })

  it('is false for anything else', () => {
    expect(codexSignedIn('Not logged in')).toBe(false)
    expect(codexSignedIn('')).toBe(false)
    expect(codexSignedIn('Error checking login status: permission denied')).toBe(false)
    expect(codexSignedIn('error: unrecognized subcommand \'login\'')).toBe(false)
  })
})

describe('githubLog', () => {
  let root: string
  const path = process.env.PATH

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'corral-github-log-'))
    process.env.PATH = `${root}:${path}`
  })

  afterEach(async () => {
    process.env.PATH = path
    await rm(root, { recursive: true, force: true })
  })

  async function fakeGh(script: string): Promise<void> {
    await writeFile(join(root, 'gh'), `#!/bin/sh\n${script}\n`)
    await chmod(join(root, 'gh'), 0o755)
  }

  // gh 2.103 prints the headers, then refuses the body unless it's told not to
  const REFUSES = `printf 'HTTP/2.0 200 OK\\r\\nContent-Type: text/plain\\r\\n\\r\\n'
case "$*" in *--allow-escape-sequences*) ;; *)
  echo 'the response contains terminal escape sequences; pass --allow-escape-sequences to output it anyway' >&2
  exit 1 ;;
esac
cat '\${LOG}'`

  it('reads a log that gh refuses to print unless told to, and only a log', async () => {
    const log = join(root, 'log')
    await writeFile(log, '\u001B[31mFAIL\u001B[0m a.test.ts\n##[error]Process completed with exit code 1.\n')
    await fakeGh(REFUSES.replace('${LOG}', log))
    expect(await githubRequest('GET', '/repos/a/b/actions/jobs/1/logs')).toEqual({ kind: 'github', status: 200, body: null })
    expect(await githubLog('/repos/a/b/actions/jobs/1/logs', 1000)).toEqual({
      kind: 'github',
      status: 200,
      body: '\u001B[31mFAIL\u001B[0m a.test.ts\n##[error]Process completed with exit code 1.',
      failureLines: ['FAIL a.test.ts', '##[error]Process completed with exit code 1.']
    })
  })

  it('keeps the end of a log past the limit on held output, and failures from its start', async () => {
    await fakeGh(`printf 'HTTP/2.0 200 OK\\n\\n'
echo 'FAIL early.test.ts'
head -c ${MAX_OUTPUT_CHARS + 1_000_000} /dev/zero | tr '\\0' 'x'
printf '\\nthe very end\\n'`)
    const result = await githubLog('/repos/a/b/actions/jobs/1/logs', 100)
    expect(result.status).toBe(200)
    expect(result.body).toMatch(/x+\nthe very end$/)
    expect(result.failureLines![0]).toBe('FAIL early.test.ts')
  }, 60_000)

  it('asks again without the flag when an older gh doesn\'t know it', async () => {
    await fakeGh(`case "$*" in *--allow-escape-sequences*) echo 'unknown flag: --allow-escape-sequences' >&2; exit 1 ;; esac
printf 'HTTP/2.0 200 OK\\n\\nthe log\\n'`)
    expect(await githubLog('/repos/a/b/actions/jobs/1/logs', 100)).toMatchObject({ status: 200, body: 'the log' })
  })

  it('keeps an error response, and throws when gh gives none', async () => {
    await fakeGh(`printf 'HTTP/2.0 404 Not Found\\n\\n{"message":"Not Found"}'; exit 1`)
    expect(await githubLog('/x', 100)).toMatchObject({ status: 404, body: { message: 'Not Found' } })
    await fakeGh(`echo 'no login' >&2; exit 1`)
    await expect(githubLog('/x', 100)).rejects.toThrow('no login')
  })
})

describe('parseIncludedResponse', () => {
  it('reads the status and JSON body from `gh api --include`', () => {
    const output = 'HTTP/2.0 201 Created\r\nContent-Type: application/json\r\n\r\n{"number":41}'
    expect(parseIncludedResponse(output)).toEqual({ status: 201, body: { number: 41 } })
  })

  it('keeps an error body for 4xx responses', () => {
    const output = 'HTTP/2.0 422 Unprocessable Entity\nContent-Type: application/json\n\n{"message":"Validation Failed"}'
    expect(parseIncludedResponse(output)).toEqual({ status: 422, body: { message: 'Validation Failed' } })
  })

  it('handles an empty body', () => {
    expect(parseIncludedResponse('HTTP/2.0 204 No Content\n\n')).toEqual({ status: 204, body: null })
  })

  it('returns null when there is no response', () => {
    expect(parseIncludedResponse('')).toBeNull()
  })
})

describe('toRepoSummary', () => {
  const repo = { full_name: 'cormac/corral', description: null, private: true, updated_at: '2026-10-27T10:00:00Z', default_branch: 'main' }

  it('can push with write, maintain or admin access', () => {
    expect(toRepoSummary({ ...repo, permissions: { push: true } }).canPush).toBe(true)
    expect(toRepoSummary({ ...repo, permissions: { admin: true } }).canPush).toBe(true)
    expect(toRepoSummary({ ...repo, permissions: { push: false } }).canPush).toBe(false)
  })
})

describe('session_title', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'corral-session-title-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  // A stub claude that records its arguments and stdin, then runs `script`
  async function fakeClaude(script: string): Promise<string> {
    const path = join(root, 'claude')
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/args"\ncat > "${root}/stdin"\n${script}\n`)
    await chmod(path, 0o755)
    return path
  }

  it('asks claude with the configured small model and no tools', async () => {
    const claudeBin = await fakeClaude('echo "Login page plan"')
    const config = { ...loadConfig({ CORRAL_TITLE_MODEL: 'tiny' }), claudeBin }
    expect(await runSetupJob(config, { kind: 'session_title', prompt: 'Title this: plan a login page' })).toEqual({ kind: 'session_title', title: 'Login page plan' })
    const args = (await readFile(join(root, 'args'), 'utf8')).split('\n')
    expect(args.slice(0, 5)).toEqual(['-p', '--model', 'tiny', '--tools', ''])
    expect(args).toContain('--strict-mcp-config')
    expect(await readFile(join(root, 'stdin'), 'utf8')).toBe('Title this: plan a login page')
  })

  it('writes Inbox messages with the same configured small model', async () => {
    const claudeBin = await fakeClaude('echo "Please review the login fix."')
    const config = { ...loadConfig({ CORRAL_TITLE_MODEL: 'tiny' }), claudeBin }
    expect(await runSetupJob(config, { kind: 'inbox_message', prompt: 'Facts only' })).toEqual({ kind: 'inbox_message', message: 'Please review the login fix.' })
    const args = (await readFile(join(root, 'args'), 'utf8')).split('\n')
    expect(args.slice(0, 5)).toEqual(['-p', '--model', 'tiny', '--tools', ''])
    expect(args).toContain('--strict-mcp-config')
    expect(args).toContain('--no-session-persistence')
    expect(await readFile(join(root, 'stdin'), 'utf8')).toBe('Facts only')
  })

  it('defaults to haiku', () => {
    expect(loadConfig({}).titleModel).toBe('haiku')
  })

  it('fails when claude fails or prints nothing', async () => {
    const config = { ...loadConfig({}), claudeBin: await fakeClaude('echo "Not logged in" >&2; exit 1') }
    await expect(runSetupJob(config, { kind: 'session_title', prompt: 'x' })).rejects.toThrow('Not logged in')
    config.claudeBin = await fakeClaude('exit 0')
    await expect(runSetupJob(config, { kind: 'session_title', prompt: 'x' })).rejects.toThrow(/code 0/)
  })
})

describe('release_notes', () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'corral-release-notes-'))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  async function fakeCli(name: string, script: string): Promise<string> {
    const path = join(root, name)
    await writeFile(path, `#!/bin/sh\nprintf '%s\\n' "$@" > "${root}/args"\ncat > "${root}/stdin"\n${script}\n`)
    await chmod(path, 0o755)
    return path
  }

  it('asks claude with no tools and the prompt on stdin', async () => {
    const config = { ...loadConfig({}), claudeBin: await fakeCli('claude', 'echo "## Features"') }
    expect(await runSetupJob(config, { kind: 'release_notes', runtime: 'claude-code', prompt: 'Write notes' })).toEqual({ kind: 'release_notes', notes: '## Features' })
    expect((await readFile(join(root, 'args'), 'utf8')).split('\n').slice(0, 3)).toEqual(['-p', '--tools', ''])
    expect(await readFile(join(root, 'stdin'), 'utf8')).toBe('Write notes')
  })

  it('asks codex when that is the runtime', async () => {
    const config = { ...loadConfig({}), codexBin: await fakeCli('codex', 'echo "## Fixes"') }
    expect(await runSetupJob(config, { kind: 'release_notes', runtime: 'codex', prompt: 'Write notes' })).toEqual({ kind: 'release_notes', notes: '## Fixes' })
    const args = (await readFile(join(root, 'args'), 'utf8')).trim().split('\n')
    expect(args[0]).toBe('exec')
    expect(args.at(-1)).toBe('-')
    expect(await readFile(join(root, 'stdin'), 'utf8')).toBe('Write notes')
  })

  it('fails when the CLI fails or prints nothing', async () => {
    const config = { ...loadConfig({}), claudeBin: await fakeCli('claude', 'echo "Not logged in" >&2; exit 1') }
    await expect(runSetupJob(config, { kind: 'release_notes', runtime: 'claude-code', prompt: 'x' })).rejects.toThrow('Not logged in')
    config.claudeBin = await fakeCli('claude', 'exit 0')
    await expect(runSetupJob(config, { kind: 'release_notes', runtime: 'claude-code', prompt: 'x' })).rejects.toThrow(/code 0/)
  })
})
