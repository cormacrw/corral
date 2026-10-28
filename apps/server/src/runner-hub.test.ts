import type { RunnerMessage, ServerMessage } from '@corral/contracts'
import { createTestDatabase } from '@corral/db/testing'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import WebSocket from 'ws'
import { EventBus } from './events.ts'
import { ensureOwner } from './owner.ts'
import { RunnerHub } from './runner-hub.ts'
import { startServer, type RunningServer } from './server.ts'

// A fake runner over a real WebSocket against a real server
describe('runner connection', () => {
  let server: RunningServer
  let hub: RunnerHub
  let close: () => Promise<void>

  beforeAll(async () => {
    const handle = await createTestDatabase('pglite')
    const events = new EventBus()
    hub = new RunnerHub(events)
    server = await startServer({ db: handle.db, events, actor: await ensureOwner(handle.db), runner: hub }, { host: '127.0.0.1', port: 0 })
    close = async () => {
      await server.close()
      await handle.close()
    }
  })

  afterAll(async () => {
    await close?.()
  })

  async function connectRunner(onJob: (message: Extract<ServerMessage, { type: 'job.request' }>) => RunnerMessage) {
    const socket = new WebSocket(`${server.url.replace('http', 'ws')}/runner`)
    const welcomed = new Promise<void>((resolve) => {
      socket.on('message', (data) => {
        const message = JSON.parse(String(data)) as ServerMessage
        if (message.type === 'welcome') resolve()
        if (message.type === 'job.request') socket.send(JSON.stringify(onJob(message)))
      })
    })
    await new Promise(resolve => socket.once('open', resolve))
    socket.send(JSON.stringify({ type: 'hello', protocol: 1, runnerId: 'r1', name: 'test-runner', activeRuns: [] } satisfies RunnerMessage))
    await welcomed
    return socket
  }

  it('reports the runner offline before it connects', async () => {
    const res = await fetch(`${server.url}/api/runner`)
    expect(await res.json()).toMatchObject({ online: false })
    const clis = await fetch(`${server.url}/api/setup/clis`)
    expect(clis.status).toBe(503)
    expect(await clis.json()).toEqual({ error: { code: 'runner_offline' } })
  })

  it('round-trips a setup job and goes offline on disconnect', async () => {
    const socket = await connectRunner(message => ({
      type: 'job.result',
      jobId: message.jobId,
      ok: true,
      result: { kind: 'detect_clis', clis: [{ id: 'claude', version: '2.1.312 (Claude Code)', signedIn: true }] }
    }))
    expect(await (await fetch(`${server.url}/api/runner`)).json()).toMatchObject({ online: true, name: 'test-runner' })

    const clis = await (await fetch(`${server.url}/api/setup/clis`)).json()
    expect(clis).toEqual([{ id: 'claude', name: 'Claude Code', version: '2.1.312 (Claude Code)', signedIn: true }])

    socket.close()
    await new Promise(resolve => setTimeout(resolve, 100))
    expect(hub.online).toBe(false)
  })

  it('marks repos already used by a project, and read-only ones, as not selectable', async () => {
    const socket = await connectRunner(message => ({
      type: 'job.result',
      jobId: message.jobId,
      ok: true,
      result: {
        kind: 'list_repos',
        signedIn: true,
        repos: [
          { nameWithOwner: 'me/free', description: null, isPrivate: false, updatedAt: '2026-10-27T10:00:00Z', defaultBranch: 'main', canPush: true },
          { nameWithOwner: 'me/taken', description: null, isPrivate: true, updatedAt: '2026-10-27T10:00:00Z', defaultBranch: 'main', canPush: true },
          { nameWithOwner: 'them/readonly', description: null, isPrivate: false, updatedAt: '2026-10-27T10:00:00Z', defaultBranch: 'main', canPush: false }
        ]
      }
    }))
    await fetch(`${server.url}/api/projects`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Taken', prefix: 'TKN', repository: 'me/taken', defaultBranch: 'main' })
    })

    const list = await (await fetch(`${server.url}/api/setup/repos`)).json() as { repos: { nameWithOwner: string, selectable: boolean, reason: string | null }[] }
    expect(list.repos.map(r => [r.nameWithOwner, r.selectable, r.reason])).toEqual([
      ['me/free', true, null],
      ['me/taken', false, 'used_by_project'],
      ['them/readonly', false, 'read_only']
    ])
    socket.close()
  })
})
