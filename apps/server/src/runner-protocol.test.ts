import { describe, expect, it, vi } from 'vitest'
import { RunnerHub, type RunnerHandlers } from './runner-hub.ts'
import { EventBus } from './events.ts'

describe('runner socket boundary', () => {
  it('logs invalid messages before any handler runs', async () => {
    const handlers: RunnerHandlers = {
      onConnected: vi.fn(), onReady: vi.fn(), onHeartbeat: vi.fn(),
      onDisconnected: vi.fn(), onRunMessage: vi.fn(), onToolCall: vi.fn()
    }
    const hub = new RunnerHub(new EventBus())
    hub.setHandlers(handlers)
    const socket = { send: vi.fn(), close: vi.fn() }
    const connection = hub.connect(socket)
    const warning = vi.spyOn(console, 'warn').mockImplementation(() => {})
    try {
      for (const raw of ['null', '{', '{"type":"hello","protocol":3}', '{"type":"run.events","events":null}']) await connection.onMessage(raw)
      expect(warning).toHaveBeenCalledTimes(4)
      const messages = warning.mock.calls.map(args => args.join(' '))
      expect(messages[0]).toContain('<unknown>')
      expect(messages[1]).toContain('<invalid JSON>')
      expect(messages[2]).toContain('hello')
      expect(messages[3]).toContain('run.events')
      expect(messages.every(m => m.includes('protocol error') && m.includes('runner → server'))).toBe(true)
      for (const handler of Object.values(handlers)) expect(handler).not.toHaveBeenCalled()
      expect(socket.send).not.toHaveBeenCalled()
      expect(hub.status().runners).toEqual([])
    } finally {
      warning.mockRestore()
    }
  })
})
