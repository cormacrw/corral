import { RUNNER_PROTOCOL_VERSION, type ServerMessage } from '@corral/contracts'
import { expect, it, vi } from 'vitest'
import { EventBus } from './events.ts'
import { RunnerHub } from './runner-hub.ts'

it('reconciles the hello snapshot before accepting new assignments', async () => {
  const hub = new RunnerHub(new EventBus())
  const sent: ServerMessage[] = []
  let reconciled!: () => void
  const reconciliation = new Promise<void>((resolve) => {
    reconciled = resolve
  })
  const ready = vi.fn()
  hub.setHandlers({
    onConnected: () => reconciliation,
    onReady: ready,
    onDisconnected: async () => {},
    onHeartbeat: async () => {},
    onRunMessage: async () => {},
    onToolCall: async () => null
  })
  const connection = hub.connect({ send: raw => sent.push(JSON.parse(raw)), close: () => {} })
  const hello = connection.onMessage(JSON.stringify({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, commit: 'development', runnerId: 'B', name: 'Gaming PC', activeRuns: [], slots: 1, runtimes: ['claude-code'], roles: ['developer'] }))
  expect(hub.online).toBe(false)
  expect(hub.pick()).toBeNull()
  expect(sent).toEqual([])
  reconciled()
  await hello
  expect(hub.pick()).toBe('B')
  expect(sent).toEqual([{ type: 'welcome', runnerId: 'B', commit: 'development', draining: false, updateRequested: false }, { type: 'job.request', jobId: expect.any(String), job: { kind: 'detect_clis' } }])
  const detection = sent[1] as Extract<ServerMessage, { type: 'job.request' }>
  await connection.onMessage(JSON.stringify({ type: 'job.result', jobId: detection.jobId, ok: true, result: { kind: 'detect_clis', clis: [] } }))
  expect(ready).toHaveBeenCalledOnce()
})

it('includes the server build in protocol refusals while listing the runner as needing an update', async () => {
  const hub = new RunnerHub(new EventBus(), 'new-commit')
  const close = vi.fn()
  const send = vi.fn()
  const peer = hub.connect({ send, close })
  await peer.onMessage(JSON.stringify({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION - 1, runnerId: 'old' }))
  expect(close).toHaveBeenCalledWith(4000, JSON.stringify({ protocol: RUNNER_PROTOCOL_VERSION, commit: 'new-commit' }))
  expect(send).not.toHaveBeenCalled()
  expect(hub.status().runners).toMatchObject([{ id: 'old', needsUpdate: true }])
})

it('lists a runner on an older protocol as needing an update until it reconnects on the current one', async () => {
  const events = new EventBus()
  const published: unknown[] = []
  events.subscribe(e => published.push(e))
  const hub = new RunnerHub(events)
  const closed = vi.fn()
  const old = hub.connect({ send: () => {}, close: closed })
  await old.onMessage(JSON.stringify({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION - 1, runnerId: 'M', name: 'old-mini', activeRuns: [] }))
  expect(closed).toHaveBeenCalledWith(4000, JSON.stringify({ protocol: RUNNER_PROTOCOL_VERSION, commit: 'development' }))
  expect(hub.status()).toMatchObject({ online: false, protocol: RUNNER_PROTOCOL_VERSION, runners: [{ id: 'M', name: 'old-mini', online: false, needsUpdate: true, protocol: RUNNER_PROTOCOL_VERSION - 1 }] })
  expect(published.at(-1)).toMatchObject({ type: 'runner.status', status: { runners: [{ id: 'M', needsUpdate: true }] } })
  expect(hub.pick()).toBeNull()

  const updated = hub.connect({ send: () => {}, close: () => {} })
  await updated.onMessage(JSON.stringify({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, runnerId: 'M', name: 'old-mini', activeRuns: [], slots: 2, runtimes: ['claude-code'], roles: ['developer'] }))
  expect(hub.status().runners).toMatchObject([{ id: 'M', online: true, needsUpdate: false, protocol: RUNNER_PROTOCOL_VERSION, slots: 2, slotsInUse: 0 }])
  hub.setInUse(new Map([['M', 1]]))
  expect(hub.status().runners[0]).toMatchObject({ slotsInUse: 1 })
})
