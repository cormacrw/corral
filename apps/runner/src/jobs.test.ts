import { chmod, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'
import { codexSignedIn, parseIncludedResponse, runSetupJob, toRepoSummary } from './jobs.ts'

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
