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
  expect(sent).toEqual([{ type: 'welcome', integrationCompatibilityReason: expect.stringContaining('Update the runner'), runnerId: 'B', commit: 'development', draining: false, updateRequested: false }, { type: 'job.request', jobId: expect.any(String), job: { kind: 'detect_clis' } }])
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

it('keeps capacity provenance in runner status, tolerating older and malformed hellos', async () => {
  const hub = new RunnerHub(new EventBus())
  const derived = { kind: 'derived', cpus: 8, memoryBytes: 10 * 1024 ** 3, slotCpus: 2, slotMemoryBytes: 2.5 * 1024 ** 3 }
  for (const [id, slots, slotSource] of [['derived', 4, derived], ['explicit', 7, { kind: 'explicit' }], ['old', 2, undefined], ['invalid', 1, { ...derived, cpus: -1 }]] as const) {
    const peer = hub.connect({ send: () => {}, close: () => {} })
    await peer.onMessage(JSON.stringify({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, commit: 'development', runnerId: id, name: id, activeRuns: [], slots, slotSource, runtimes: [], roles: ['developer'] }))
  }
  expect(hub.status().runners).toMatchObject([
    { id: 'derived', slots: 4, slotSource: derived },
    { id: 'explicit', slots: 7, slotSource: { kind: 'explicit' } },
    { id: 'old', slots: 2, slotSource: undefined },
    { id: 'invalid', slots: 1, slotSource: undefined }
  ])
})

it('negotiates integration separately from envelope version and fences dispatch by exact support', async () => {
  const hub = new RunnerHub(new EventBus())
  for (const [id, taskIntegrationProtocols] of [['legacy', undefined], ['capable', [1]], ['future', [2]]] as const) {
    const sent: ServerMessage[] = []
    const peer = hub.connect({ send: raw => sent.push(JSON.parse(raw)), close: () => {} })
    await peer.onMessage(JSON.stringify({ type: 'hello', protocol: RUNNER_PROTOCOL_VERSION, runnerId: id, name: id, activeRuns: [], taskIntegrationProtocols }))
    const detection = sent.find(m => m.type === 'job.request') as Extract<ServerMessage, { type: 'job.request' }>
    await peer.onMessage(JSON.stringify({ type: 'job.result', jobId: detection.jobId, ok: true, result: { kind: 'detect_clis', clis: [] } }))
    const job = {
      runId: 'run', runNumber: 1, leaseEpoch: 1, runtime: 'codex', projectId: 'project', repository: 'cormacrw/test-app', defaultBranch: 'main',
      agentSessionId: null, prompt: 'work', fallbackPrompt: null, model: null, timeoutSeconds: 60,
      role: 'developer' as const, taskId: 'task', taskRef: 'TA-1', branch: 'corral/task', headSha: 'head', planSessionId: null, integrationProtocol: 1
    }
    expect(hub.send({ type: 'run.assign', job }, id)).toBe(id === 'capable')
    expect(hub.send({ type: 'run.assign', job: { ...job, integrationProtocol: 0 } }, id)).toBe(true)
    expect(hub.status().runners.find(r => r.id === id)?.integrationCompatibilityReason).toEqual(id === 'capable' ? null : expect.stringContaining('Update the runner'))
  }
})
