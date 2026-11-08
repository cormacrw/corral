import { homedir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { loadConfig } from './config.ts'

describe('loadConfig', () => {
  it('uses local development defaults when nothing is set', () => {
    expect(loadConfig({})).toEqual({
      dataDir: join(homedir(), '.corral', 'server'),
      host: '127.0.0.1',
      port: 4100,
      databaseUrl: undefined,
      publicUrl: 'http://localhost:3000',
      demo: false,
      buildSha: 'development',
      slowRequestMs: 500,
      slowQueryMs: 200
    })
  })

  it('reads every value from the environment', () => {
    expect(loadConfig({
      CORRAL_SERVER_DATA_DIR: '/data/server',
      CORRAL_SERVER_HOST: '0.0.0.0',
      CORRAL_SERVER_PORT: '8080',
      CORRAL_DATABASE_URL: 'postgres://corral@postgres/corral',
      CORRAL_PUBLIC_URL: 'https://corral.example.com/',
      CORRAL_BUILD_SHA: 'abc123',
      CORRAL_SLOW_REQUEST_MS: '10',
      CORRAL_SLOW_QUERY_MS: '0'
    })).toEqual({
      dataDir: '/data/server',
      host: '0.0.0.0',
      port: 8080,
      databaseUrl: 'postgres://corral@postgres/corral',
      publicUrl: 'https://corral.example.com',
      demo: false,
      buildSha: 'abc123',
      slowRequestMs: 10,
      slowQueryMs: 0
    })
  })

  it('runs as a demo only when CORRAL_DEMO is 1', () => {
    expect(loadConfig({ CORRAL_DEMO: '1' }).demo).toBe(true)
    expect(loadConfig({ CORRAL_DEMO: 'true' }).demo).toBe(false)
  })

  it('requires a token before enabling the external listener', () => {
    expect(() => loadConfig({ CORRAL_RUNNER_LISTEN: '0.0.0.0:4200' })).toThrow(/CORRAL_RUNNER_TOKEN/)
    expect(loadConfig({ CORRAL_RUNNER_LISTEN: '[::1]:4200', CORRAL_RUNNER_TOKEN: 'secret' }).runnerListen).toEqual({ host: '::1', port: 4200 })
    for (const value of ['4200', 'host:0', 'host:65536', 'http://host:4200']) {
      expect(() => loadConfig({ CORRAL_RUNNER_LISTEN: value, CORRAL_RUNNER_TOKEN: 'secret' })).toThrow(/CORRAL_RUNNER_LISTEN/)
    }
  })

  it('falls back to the default slow thresholds for a bad value', () => {
    expect(loadConfig({ CORRAL_SLOW_REQUEST_MS: 'soon', CORRAL_SLOW_QUERY_MS: '-1' })).toMatchObject({ slowRequestMs: 500, slowQueryMs: 200 })
  })

  it('rejects a port that is not a number', () => {
    expect(() => loadConfig({ CORRAL_SERVER_PORT: 'abc' })).toThrow(/CORRAL_SERVER_PORT/)
  })
})
