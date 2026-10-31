import { RUNNER_HEARTBEAT_MS, RUNNER_PROTOCOL_VERSION, TASK_INTEGRATION_PROTOCOL, type RunnerCapacity, type RunnerMessage, type ServerMessage } from '@corral/contracts'
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type ServerOptions, type WebSocket } from 'ws'
import { ServerConnection } from './connection.ts'
import { UpdateStatus } from './update-status.ts'

describe('runner update status on the wire', () => {
  let dataDir: string
  let server: WebSocketServer
  let connection: ServerConnection
  let active: { runId: string, leaseEpoch: number }[] = []
  let finishingCount: number | undefined
  const received: RunnerMessage[] = []
  const signedIn = async (): Promise<RunnerCapacity> => ({ slots: 2, runtimes: ['codex'], roles: ['developer'] })
  let capacity = signedIn
  let serverOptions: ServerOptions = {}
  afterEach(async () => {
    capacity = signedIn
    serverOptions = {}
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
    server = new WebSocketServer({ port: 0, host: '127.0.0.1', ...serverOptions })
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
      capacity: () => capacity(),
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

  it('logs malformed server messages and dispatches only valid traffic', async () => {
    const warnings = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      await start(false, (socket) => {
        for (const raw of ['null', '{', JSON.stringify({ type: 'run.assign', job: {} }), JSON.stringify({ type: 'welcome', commit: 42 })]) socket.send(raw)
        socket.send(JSON.stringify({ type: 'welcome', runnerId: 'r1', commit: 'valid', draining: false, updateRequested: false }))
      })
      await vi.waitFor(async () => expect(await status()).toMatchObject({ serverCommit: 'valid', activeRunCount: 0 }))
      expect(warnings).toHaveBeenCalledTimes(4)
      const messages = warnings.mock.calls.map(args => args.join(' '))
      expect(messages[0]).toContain('<unknown>')
      expect(messages[1]).toContain('<invalid JSON>')
      expect(messages[2]).toContain('run.assign')
      expect(messages[3]).toContain('welcome')
      expect(messages.every(m => m.includes('protocol error') && m.includes('server → runner'))).toBe(true)
    } finally {
      warnings.mockRestore()
    }
  })

  it('learns the server commit even when refused before welcome', async () => {
    await start(false, (socket, hello) => {
      expect(hello.protocol).toBe(RUNNER_PROTOCOL_VERSION)
      expect(hello.taskIntegrationProtocols).toEqual([TASK_INTEGRATION_PROTOCOL])
      socket.close(4000, JSON.stringify({ protocol: RUNNER_PROTOCOL_VERSION + 1, commit: 'new' }))
    })
    await vi.waitFor(async () => expect(await status()).toMatchObject({ commit: 'old', serverCommit: 'new', behind: true, idle: true, activeRunCount: 0 }))
  })

  it.each([false, true])('compares welcome and drains only with auto update = %s, preserving live work until it ends', async (autoUpdate) => {
    active = [{ runId: 'run-1', leaseEpoch: 1 }]
    let peer: WebSocket | undefined
    await start(autoUpdate, (socket) => {
      peer = socket
      // A local status write must not stand in for server receipt of a frame.
      socket.pause()
      socket.send(JSON.stringify({ type: 'welcome', runnerId: 'r1', commit: 'new', draining: false, updateRequested: false } satisfies ServerMessage))
    })
    await vi.waitFor(async () => expect(await status()).toMatchObject({ behind: true, draining: autoUpdate, activeRunCount: 1, idle: false, updateRequested: false }))
    expect(received.find(m => m.type === 'hello')).toMatchObject({ commit: 'old', autoUpdate })
    expect(received.some(m => m.type === 'runner.draining')).toBe(false)
    active = []
    connection.send({ type: 'run.ended', runId: 'run-1', leaseEpoch: 1, exit: { kind: 'exited', code: 0 }, headSha: null })
    peer!.resume()
    // Frames arrive in order. Receiving run.ended guarantees any earlier
    // drain notification has arrived before we assert its presence or absence.
    await vi.waitFor(() => expect(received.some(m => m.type === 'run.ended')).toBe(true))
    expect(received.filter(m => m.type === 'runner.draining')).toEqual(autoUpdate ? [{ type: 'runner.draining', updateRequested: false }] : [])
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

  const WELCOME = { type: 'welcome', runnerId: 'r1', commit: 'old', draining: false, updateRequested: false } satisfies ServerMessage
  const EVENTS = { type: 'run.events', runId: 'run-1', leaseEpoch: 1, events: [] } satisfies RunnerMessage

  it('reports nothing as sent between the socket opening and its hello', async () => {
    const detected = Promise.withResolvers<RunnerCapacity>()
    capacity = () => detected.promise
    await start(false, () => {})
    await vi.waitFor(() => expect(server.clients.size).toBe(1))
    await vi.waitFor(() => expect([...server.clients][0]!.readyState).toBe(1))
    await new Promise(resolve => setTimeout(resolve, 20))

    expect(connection.connected).toBe(false)
    expect(connection.send({ type: 'job.result', jobId: 'j1', ok: true, result: { kind: 'detect_clis', clis: [] } })).toBe(false)

    detected.resolve({ slots: 2, runtimes: ['codex'], roles: ['developer'] })
    await vi.waitFor(() => expect(received.map(m => m.type)).toEqual(['hello']))
    expect(connection.connected).toBe(true)
  })

  it('survives the socket closing while the hello is being prepared', async () => {
    const detected = Promise.withResolvers<RunnerCapacity>()
    capacity = () => detected.promise
    await start(false, () => {})
    await vi.waitFor(() => expect(server.clients.size).toBe(1))
    connection.close()
    detected.resolve({ slots: 2, runtimes: ['codex'], roles: ['developer'] })
    await new Promise(resolve => setTimeout(resolve, 20))
    expect(received).toEqual([])
  })

  it('holds run traffic until welcome, so a replay stays in order', async () => {
    let peer: WebSocket | undefined
    await start(false, socket => (peer = socket))
    await vi.waitFor(() => expect(connection.connected).toBe(true))
    expect(connection.send(EVENTS)).toBe(false)

    peer!.send(JSON.stringify(WELCOME))
    await vi.waitFor(() => expect(connection.send(EVENTS)).toBe(true))
    await vi.waitFor(() => expect(received.some(m => m.type === 'run.events')).toBe(true))
  })

  it.each([4000, 4001, 4003])('waits at least 15 s after a refusal with code %i, even though the socket opened', async (code) => {
    const delays = vi.spyOn(globalThis, 'setTimeout')
    try {
      await start(false, socket => socket.close(code, 'Refused'))
      await vi.waitFor(() => expect(delays.mock.calls.some(([, ms]) => (ms ?? 0) >= 15_000)).toBe(true))
      expect(received.filter(m => m.type === 'hello')).toHaveLength(1)
    } finally {
      delays.mockRestore()
    }
  })

  it('keeps backing off while sockets open and close without a welcome', async () => {
    const delays = vi.spyOn(globalThis, 'setTimeout')
    try {
      await start(false, socket => socket.close(1011))
      await vi.waitFor(() => expect(received.filter(m => m.type === 'hello').length).toBeGreaterThanOrEqual(2), { timeout: 4000 })
      connection.close()
      // Doubled from 1 s, so the second wait can pass what the first could not
      const retries = delays.mock.calls.flatMap(([, ms]) => (ms ?? 0) >= 500 && (ms ?? 0) <= 2000 ? [ms!] : [])
      expect(retries.length).toBeGreaterThanOrEqual(2)
    } finally {
      delays.mockRestore()
    }
  })

  it('terminates a socket whose server stopped answering, and reconnects', async () => {
    let closed: Promise<unknown> | undefined
    serverOptions = { autoPong: false }
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await start(false, socket => socket.send(JSON.stringify(WELCOME)))
      await vi.waitFor(() => expect(connection.connected).toBe(true))
      const peer = [...server.clients][0]!
      closed = new Promise(resolve => peer.once('close', resolve))
      await vi.advanceTimersByTimeAsync(RUNNER_HEARTBEAT_MS)
      await vi.advanceTimersByTimeAsync(RUNNER_HEARTBEAT_MS)
      expect(connection.connected).toBe(true)
      await vi.advanceTimersByTimeAsync(RUNNER_HEARTBEAT_MS)
    } finally {
      vi.useRealTimers()
    }
    await closed
    await vi.waitFor(() => expect(received.filter(m => m.type === 'hello')).toHaveLength(2), { timeout: 4000 })
  })

  it('keeps a quiet socket whose server answers its pings', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
    try {
      await start(false, socket => socket.send(JSON.stringify(WELCOME)))
      await vi.waitFor(() => expect(connection.connected).toBe(true))
      for (let beat = 0; beat < 4; beat++) {
        await vi.advanceTimersByTimeAsync(RUNNER_HEARTBEAT_MS)
        await new Promise(resolve => setImmediate(resolve))
        await vi.waitFor(() => expect(received.filter(m => m.type === 'heartbeat')).toHaveLength(beat + 1))
        await new Promise(resolve => setTimeout(resolve, 20))
      }
    } finally {
      vi.useRealTimers()
    }
    expect(connection.connected).toBe(true)
    expect(received.filter(m => m.type === 'hello')).toHaveLength(1)
  })
})
