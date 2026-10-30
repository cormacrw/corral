import { RUNNER_PROTOCOL_VERSION, type RunnerMessage, type ServerMessage } from '@corral/contracts'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import { ServerConnection } from './connection.ts'
import { UpdateStatus } from './update-status.ts'

describe('runner update status on the wire', () => {
  let dataDir: string
  let server: WebSocketServer
  let connection: ServerConnection
  let active: { runId: string, leaseEpoch: number }[] = []
  let finishingCount: number | undefined
  const received: RunnerMessage[] = []
  afterEach(async () => {
    connection?.close()
    server?.clients.forEach(s => s.terminate())
    if (server) await new Promise<void>(resolve => server.close(() => resolve()))
    if (dataDir) await rm(dataDir, { recursive: true, force: true })
    received.length = 0
    active = []
    finishingCount = undefined
  })

  async function start(autoUpdate: boolean, handler: (socket: WebSocket, hello: Extract<RunnerMessage, { type: 'hello' }>) => void) {
    dataDir = await mkdtemp(join(tmpdir(), 'corral-update-'))
    server = new WebSocketServer({ port: 0, host: '127.0.0.1' })
    await new Promise(resolve => server.once('listening', resolve))
    const address = server.address()
    if (typeof address === 'string' || !address) throw new Error('No port')
    server.on('connection', socket => socket.on('message', (raw) => {
      const message = JSON.parse(String(raw)) as RunnerMessage
      received.push(message)
      if (message.type === 'hello') handler(socket, message)
    }))
    connection = new ServerConnection(new URL(`http://127.0.0.1:${address.port}`), { runnerId: 'r1', name: 'runner' }, {
      activeRuns: () => active,
      activeRunCount: () => finishingCount ?? active.length,
      capacity: async () => ({ slots: 2, runtimes: ['codex'], roles: ['developer'] }),
      onMessage: (message) => {
        if (message.type === 'run.assign') active.push({ runId: message.job.runId, leaseEpoch: message.job.leaseEpoch })
      },
      onStatus: () => {}
    }, undefined, new UpdateStatus(dataDir, 'old', autoUpdate))
    connection.start()
  }

  async function status() {
    return JSON.parse(await readFile(join(dataDir, 'update-status.json'), 'utf8'))
  }

  it('releases a failed host build drain and reports the failure without stopping live work', async () => {
    active = [{ runId: 'run-1', leaseEpoch: 1 }]
    await start(true, socket => socket.send(JSON.stringify({ type: 'welcome', runnerId: 'r1', commit: 'new', draining: true, updateRequested: true } satisfies ServerMessage)))
    await vi.waitFor(async () => expect(await status()).toMatchObject({ draining: true }))
    await writeFile(join(dataDir, 'updater-result.json'), JSON.stringify({ target: 'new', state: 'failed', error: 'Image build failed', attempt: '1' }))
    await vi.waitFor(async () => expect(await status()).toMatchObject({ draining: false, updateRequested: false, updateState: 'failed', activeRunCount: 1 }), { timeout: 2500 })
    expect(active).toHaveLength(1)
    await vi.waitFor(() => expect(received).toContainEqual(expect.objectContaining({ type: 'runner.update-status', draining: false, updateError: 'Image build failed' })))
    // Even a retry that fails before polling observes 'building' must release drain.
    server.clients.forEach(socket => socket.send(JSON.stringify({ type: 'runner.drain', updateRequested: true } satisfies ServerMessage)))
    await vi.waitFor(async () => expect(await status()).toMatchObject({ draining: true }))
    await writeFile(join(dataDir, 'updater-result.json'), JSON.stringify({ target: 'new', state: 'failed', error: 'Image build failed', attempt: '2' }))
    await vi.waitFor(async () => expect(await status()).toMatchObject({ draining: false, updateRequested: false, updateState: 'failed' }), { timeout: 2500 })
  })

  it('learns the server commit even when refused before welcome', async () => {
    await start(false, (socket, hello) => {
      expect(hello.protocol).toBe(RUNNER_PROTOCOL_VERSION)
      socket.close(4000, JSON.stringify({ protocol: RUNNER_PROTOCOL_VERSION + 1, commit: 'new' }))
    })
    await vi.waitFor(async () => expect(await status()).toMatchObject({ commit: 'old', serverCommit: 'new', behind: true, idle: true, activeRunCount: 0 }))
  })

  it.each([false, true])('compares welcome and drains only with auto update = %s, preserving live work until it ends', async (autoUpdate) => {
    active = [{ runId: 'run-1', leaseEpoch: 1 }]
    await start(autoUpdate, socket => socket.send(JSON.stringify({ type: 'welcome', runnerId: 'r1', commit: 'new', draining: false, updateRequested: false } satisfies ServerMessage)))
    await vi.waitFor(async () => expect(await status()).toMatchObject({ behind: true, draining: autoUpdate, activeRunCount: 1, idle: false, updateRequested: false }))
    expect(received.find(m => m.type === 'hello')).toMatchObject({ commit: 'old', autoUpdate })
    expect(received.some(m => m.type === 'runner.draining')).toBe(autoUpdate)
    active = []
    connection.send({ type: 'run.ended', runId: 'run-1', leaseEpoch: 1, exit: { kind: 'exited', code: 0 }, headSha: null })
    expect(await status()).toMatchObject({ behind: true, draining: autoUpdate, idle: true })
  })

  it('stays busy while a completed process is still preparing its terminal report', async () => {
    finishingCount = 1
    await start(false, socket => socket.send(JSON.stringify({ type: 'welcome', runnerId: 'r1', commit: 'new', draining: true, updateRequested: true } satisfies ServerMessage)))
    await vi.waitFor(async () => expect(await status()).toMatchObject({ draining: true, updateRequested: true, activeRunCount: 1, idle: false }))
    // The heartbeat snapshot has no running process, but the manager still owns the report.
    expect(active).toEqual([])
    finishingCount = 0
    connection.refreshUpdateStatus()
    expect(await status()).toMatchObject({ activeRunCount: 0, idle: true })
  })

  it('records server-requested drain, preserves it on reconnect, and starts clear after restart', async () => {
    active = [{ runId: 'run-1', leaseEpoch: 1 }]
    await start(false, (socket) => {
      socket.send(JSON.stringify({ type: 'welcome', runnerId: 'r1', commit: 'new', draining: false, updateRequested: false } satisfies ServerMessage))
      socket.send(JSON.stringify({ type: 'runner.drain', updateRequested: true } satisfies ServerMessage))
    })
    await vi.waitFor(async () => expect(await status()).toMatchObject({ draining: true, updateRequested: true, idle: false }))
    server.clients.forEach(s => s.close())
    await vi.waitFor(() => expect(received.filter(m => m.type === 'hello')).toHaveLength(2), { timeout: 4000 })
    expect(received.filter(m => m.type === 'hello')[1]).toMatchObject({ draining: true, updateRequested: true })
    active = []
    connection.refreshUpdateStatus()
    expect(await status()).toMatchObject({ idle: true, activeRunCount: 0, updateRequested: true })
    connection.close()
    const restarted = new UpdateStatus(dataDir, 'new', true)
    restarted.server('new')
    restarted.write(0)
    expect(await status()).toMatchObject({ behind: false, draining: false, updateRequested: false, idle: true })
  })
})
