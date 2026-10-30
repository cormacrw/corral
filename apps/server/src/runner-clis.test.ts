import type { ServerMessage } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { EventBus } from './events.ts'
import { RunnerHub } from './runner-hub.ts'

function connection(hub: RunnerHub, runnerId = 'r1') {
  const sent: ServerMessage[] = []
  const peer = hub.connect({ send: data => sent.push(JSON.parse(data)), close() {} })
  const hello = () => peer.onMessage(JSON.stringify({ type: 'hello', protocol: 2, runnerId, name: 'test', activeRuns: [], slots: 1, runtimes: ['claude-code'], roles: ['developer'] }))
  const detections = () => sent.filter((m): m is Extract<ServerMessage, { type: 'job.request' }> => m.type === 'job.request' && m.job.kind === 'detect_clis')
  const answer = async (version: string | null) => peer.onMessage(JSON.stringify({
    type: 'job.result', jobId: detections().at(-1)!.jobId, ok: true,
    result: { kind: 'detect_clis', clis: [{ id: 'codex', version, signedIn: true }] }
  }))
  return { peer, hello, detections, answer }
}

describe('runner CLI cache', () => {
  it('shares connection detection, uses the last result during refresh, and refreshes on reconnect', async () => {
    const hub = new RunnerHub(new EventBus())
    const first = connection(hub)
    await first.hello()
    const pending = hub.detectClis()
    expect(first.detections()).toHaveLength(1)
    await first.answer('1.0')
    expect((await pending).clis[0]!.version).toBe('1.0')
    expect((await hub.detectClis()).clis[0]!.version).toBe('1.0')
    expect(first.detections()).toHaveLength(1)
    const refresh = hub.detectClis(true)
    expect((await hub.detectClis()).clis[0]!.version).toBe('1.0')
    await first.answer(null)
    await refresh
    expect((await hub.detectClis()).clis[0]!.version).toBeNull()
    await first.peer.onClose()
    await expect(hub.detectClis()).rejects.toMatchObject({ status: 503 })
    const second = connection(hub)
    await second.hello()
    expect(second.detections()).toHaveLength(1)
    await second.answer('2.0')
    expect((await hub.detectClis()).clis[0]!.version).toBe('2.0')
    await second.peer.onClose()
  })

  it('keeps detection results separate when the selected runner disconnects', async () => {
    const hub = new RunnerHub(new EventBus())
    const first = connection(hub, 'r1')
    const second = connection(hub, 'r2')
    await first.hello()
    await first.answer('1.0')
    await second.hello()
    await second.answer('2.0')
    expect((await hub.detectClis()).clis[0]!.version).toBe('1.0')
    await first.peer.onClose()
    expect((await hub.detectClis()).clis[0]!.version).toBe('2.0')
    expect(second.detections()).toHaveLength(1)
    const refresh = hub.detectClis(true)
    await second.answer('2.1')
    expect((await refresh).clis[0]!.version).toBe('2.1')
    await second.peer.onClose()
  })

  it('falls back to a live check after connection detection fails', async () => {
    const hub = new RunnerHub(new EventBus())
    const c = connection(hub)
    await c.hello()
    const failed = hub.detectClis()
    const rejected = expect(failed).rejects.toThrow('Detection unavailable')
    await c.peer.onMessage(JSON.stringify({ type: 'job.result', jobId: c.detections()[0]!.jobId, ok: false, error: 'Detection unavailable' }))
    await rejected
    const retry = hub.detectClis()
    expect(c.detections()).toHaveLength(2)
    await c.answer('3.0')
    expect((await retry).clis[0]!.version).toBe('3.0')
    await c.peer.onClose()
  })
})
