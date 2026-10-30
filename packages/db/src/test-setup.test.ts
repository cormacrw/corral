import { EventEmitter } from 'node:events'
import { access } from 'node:fs/promises'
import { afterEach, expect, it, vi } from 'vitest'
import { startTestPostgres } from './test-setup.ts'

const state = vi.hoisted(() => ({
  directory: '',
  onLog: vi.fn<(message: unknown) => void>(),
  onError: vi.fn<(message: unknown) => void>(),
  initialise: vi.fn(),
  start: vi.fn(),
  child: undefined as unknown
}))
vi.mock('embedded-postgres', () => ({
  default: class {
    process = state.child
    constructor(options: { databaseDir: string, onLog: typeof state.onLog, onError: typeof state.onError }) {
      state.directory = options.databaseDir
      state.onLog = options.onLog
      state.onError = options.onError
    }

    initialise = state.initialise
    start = state.start
  }
}))
afterEach(() => {
  vi.resetAllMocks()
  vi.useRealTimers()
  state.child = undefined
})

it('retains the bounded tail of both startup streams and removes failed init data', async () => {
  state.initialise.mockImplementation(async () => {
    state.onLog('discarded-prefix' + 'x'.repeat(20_000))
    state.onError('FATAL: init failed')
    throw new Error('initdb exited')
  })
  const error = await startTestPostgres().catch((error: unknown) => error) as Error
  expect(error.message).toContain('FATAL: init failed')
  expect(error.message).toContain('initdb exited')
  expect(error.message).not.toContain('discarded-prefix')
  expect(error.message.length).toBeLessThan(17_000)
  await expect(access(state.directory)).rejects.toThrow()
  expect(state.start).not.toHaveBeenCalled()
})

it('does not wait for a second exit when startup has already exited', async () => {
  const kill = vi.fn()
  state.child = { exitCode: 1, signalCode: null, kill }
  state.start.mockImplementation(async () => {
    state.onLog('FATAL: address already in use')
    throw new Error('startup exited')
  })
  await expect(startTestPostgres()).rejects.toThrow('FATAL: address already in use')
  expect(kill).not.toHaveBeenCalled()
  await expect(access(state.directory)).rejects.toThrow()
})

it('reaps a partially started child before removing its directory', async () => {
  const child = Object.assign(new EventEmitter(), {
    exitCode: null,
    signalCode: null,
    kill: vi.fn(() => {
      queueMicrotask(() => child.emit('exit', 0))
      return true
    })
  })
  state.child = child
  state.start.mockRejectedValue(new Error('readiness failed'))
  await expect(startTestPostgres()).rejects.toThrow('readiness failed')
  expect(child.kill).toHaveBeenCalledWith('SIGINT')
  await expect(access(state.directory)).rejects.toThrow()
})

it('returns a URL without changing the environment and cleans up on close', async () => {
  const original = process.env.CORRAL_DATABASE_URL
  const server = await startTestPostgres()
  expect(server.url).toMatch(/^postgres:\/\/postgres:postgres@127\.0\.0\.1:\d+\/postgres$/)
  expect(process.env.CORRAL_DATABASE_URL).toBe(original)
  await server.close()
  await expect(access(state.directory)).rejects.toThrow()
})
