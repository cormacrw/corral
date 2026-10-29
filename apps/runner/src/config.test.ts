import { homedir, hostname } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { gitAuthorWarning, loadConfig } from './config.ts'

describe('loadConfig', () => {
  it('uses local development defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      dataDir: join(homedir(), '.corral', 'runner'),
      serverUrl: new URL('http://127.0.0.1:4100'),
      name: hostname(),
      claudeBin: 'claude',
      gitAuthor: null
    })
  })

  it('reads every value from the environment', () => {
    expect(loadConfig({
      CORRAL_RUNNER_DATA_DIR: '/data/runner',
      CORRAL_SERVER_URL: 'http://server:4100',
      CORRAL_RUNNER_NAME: 'home-server',
      CORRAL_CLAUDE_BIN: '/usr/local/bin/claude',
      CORRAL_GIT_AUTHOR_NAME: 'Configured Person',
      CORRAL_GIT_AUTHOR_EMAIL: 'configured@example.com'
    })).toEqual({
      dataDir: '/data/runner',
      serverUrl: new URL('http://server:4100'),
      name: 'home-server',
      claudeBin: '/usr/local/bin/claude',
      gitAuthor: { name: 'Configured Person', email: 'configured@example.com' }
    })
  })

  it('rejects a server URL that does not parse', () => {
    expect(() => loadConfig({ CORRAL_SERVER_URL: 'not a url' })).toThrow(/CORRAL_SERVER_URL/)
  })

  it('needs both git author settings, and warns at startup without them', () => {
    const unset = loadConfig({})
    const halfSet = loadConfig({ CORRAL_GIT_AUTHOR_EMAIL: 'configured@example.com' })
    const set = loadConfig({ CORRAL_GIT_AUTHOR_NAME: 'Configured Person', CORRAL_GIT_AUTHOR_EMAIL: 'configured@example.com' })
    expect(halfSet.gitAuthor).toBeNull()
    expect(gitAuthorWarning(unset)).toMatch(/agent commits will have an unpredictable author/)
    expect(gitAuthorWarning(halfSet)).toMatch(/agent commits will have an unpredictable author/)
    expect(gitAuthorWarning(set)).toBeNull()
  })
})
