import { RUNNER_PROTOCOL_VERSION } from '@corral/contracts'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import WebSocket from 'ws'
import { createTestApp, type TestApp } from './test-app.ts'

let t: TestApp | undefined
let socket: WebSocket | undefined
afterEach(async () => {
  socket?.terminate()
  await t?.close()
  vi.restoreAllMocks()
})

function dial(url: string, token?: string): WebSocket {
  const ws = new WebSocket(`${url.replace('http', 'ws')}/runner`, {
    headers: token ? { authorization: `Bearer ${token}` } : {}
  })
  ws.on('open', () => ws.send(JSON.stringify({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, commit: 'development', runnerId: 'auth-test', name: 'auth-test', activeRuns: [], slots: 1, runtimes: ['claude-code'], roles: ['developer'] })))
  socket = ws
  return ws
}

describe('runner listener authentication', () => {
  for (const runnerOnly of [true, false]) {
    describe(`runnerOnly=${runnerOnly}`, () => {
      beforeEach(async () => {
        t = await createTestApp('pglite', { listen: true, runnerOnly, runnerToken: 'correct' })
      })
      it(`accepts an authenticated runner (runnerOnly=${runnerOnly})`, async () => {
        const ws = dial(t!.server!.url, 'correct')
        const message = await new Promise<string>(resolve => ws.once('message', data => resolve(String(data))))
        expect(JSON.parse(message)).toEqual({ type: 'welcome', runnerId: 'auth-test', commit: 'development', draining: false, updateRequested: false })
        expect(t!.runner.online).toBe(true)
        for (const path of ['/api/runner', '/api/projects', '/api/anything']) {
          expect((await fetch(t!.server!.url + path)).status).toBe(runnerOnly ? 404 : path === '/api/anything' ? 404 : 200)
        }
        // The authenticated socket can execute jobs on either listener.
        ws.on('message', (data) => {
          const job = JSON.parse(String(data))
          if (job.type === 'job.request') ws.send(JSON.stringify({ type: 'job.result', jobId: job.jobId, ok: true, result: { kind: 'detect_clis', clis: [] } }))
        })
        expect(await t!.runner.request({ kind: 'detect_clis' })).toEqual({ kind: 'detect_clis', clis: [] })
      })
      for (const token of [undefined, 'incorrect', 'correct-but-longer']) {
        it(`rejects ${token ? 'wrong' : 'missing'} credentials before going online (runnerOnly=${runnerOnly})`, async () => {
          const log = vi.spyOn(console, 'warn').mockImplementation(() => {})
          const ws = dial(t!.server!.url, token)
          const close = await new Promise<{ code: number, reason: string }>(resolve => ws.once('close', (code, reason) => resolve({ code, reason: String(reason) })))
          expect(close).toEqual({ code: 4003, reason: 'Missing or invalid runner token' })
          expect(t!.runner.online).toBe(false)
          expect(log).toHaveBeenCalledWith('Runner authentication rejected: missing or invalid runner token')
          expect(JSON.stringify(log.mock.calls)).not.toContain('correct')
        })
      }
    })
  }
})
