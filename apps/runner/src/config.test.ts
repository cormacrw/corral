import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

describe('loadConfig', () => {
  it('uses local development defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      dataDir: join(homedir(), '.corral', 'runner'),
      serverUrl: new URL('http://127.0.0.1:4100')
    })
  })

  it('reads every value from the environment', () => {
    expect(loadConfig({
      CORRAL_RUNNER_DATA_DIR: '/data/runner',
      CORRAL_SERVER_URL: 'http://server:4100'
    })).toEqual({ dataDir: '/data/runner', serverUrl: new URL('http://server:4100') })
  })

  it('rejects a server URL that does not parse', () => {
    expect(() => loadConfig({ CORRAL_SERVER_URL: 'not a url' })).toThrow(/CORRAL_SERVER_URL/)
  })
})
