import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

describe('loadConfig', () => {
  it('uses local development defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      dataDir: join(homedir(), '.corral', 'server'),
      host: '127.0.0.1',
      port: 4100
    })
  })

  it('reads every value from the environment', () => {
    expect(loadConfig({
      CORRAL_SERVER_DATA_DIR: '/data/server',
      CORRAL_SERVER_HOST: '0.0.0.0',
      CORRAL_SERVER_PORT: '8080'
    })).toEqual({ dataDir: '/data/server', host: '0.0.0.0', port: 8080 })
  })

  it('rejects a port that is not a number', () => {
    expect(() => loadConfig({ CORRAL_SERVER_PORT: 'abc' })).toThrow(/CORRAL_SERVER_PORT/)
  })
})
