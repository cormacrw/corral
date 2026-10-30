import { RUNNER_PATH, RUNNER_PROTOCOL_VERSION } from '@corral/contracts'
import { serve, type ServerType } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import { createHash, timingSafeEqual } from 'node:crypto'
import type { AddressInfo } from 'node:net'
import { createApp, type AppDeps } from './app.ts'

export interface RunningServer {
  url: string
  close(): Promise<void>
}

// Both listeners share the runner hub; the external listener never mounts the API (D25).
export function startServer(deps: AppDeps, options: { host: string, port: number, runnerToken?: string | undefined, runnerOnly?: boolean | undefined }): Promise<RunningServer> {
  if (options.runnerOnly && !options.runnerToken) throw new Error('CORRAL_RUNNER_TOKEN is required for CORRAL_RUNNER_LISTEN')
  const root = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: root })

  // Host updaters obtain the release target directly, independently of agent-writable files.
  root.get(`${RUNNER_PATH}/version`, (context) => {
    if (options.runnerToken && !tokenMatches(context.req.header('authorization'), options.runnerToken)) return context.json({ error: 'unauthorized' }, 401)
    return context.json({ commit: deps.runner.commit, protocol: RUNNER_PROTOCOL_VERSION })
  })

  root.get(RUNNER_PATH, upgradeWebSocket((context) => {
    const supplied = context.req.header('authorization')
    const authenticated = !options.runnerToken || tokenMatches(supplied, options.runnerToken)
    let connection: ReturnType<AppDeps['runner']['connect']> | null = null
    return {
      onOpen: (_event, ws) => {
        if (!authenticated) {
          console.warn('Runner authentication rejected: missing or invalid runner token')
          ws.close(4003, 'Missing or invalid runner token')
          return
        }
        connection = deps.runner.connect({
          send: data => ws.send(data),
          close: (code, reason) => ws.close(code, reason)
        })
      },
      onMessage: (event) => {
        void connection?.onMessage(String(event.data))
      },
      onClose: () => {
        void connection?.onClose()
      }
    }
  }))
  if (!options.runnerOnly) root.route('/', createApp(deps))

  return new Promise((resolve, reject) => {
    const server: ServerType = serve({ fetch: root.fetch, hostname: options.host, port: options.port }, (info: AddressInfo) => {
      resolve({
        url: `http://${info.address.includes(':') ? `[${info.address}]` : info.address}:${info.port}`,
        // close() alone waits for every connection, and the runner's upgraded
        // WebSocket never ends on its own, so it's closed first and the rest
        // are dropped (Docker stop, dev restarts)
        close: () => new Promise((done) => {
          deps.runner.disconnect()
          server.close(() => done())
          if ('closeAllConnections' in server) (server as { closeAllConnections(): void }).closeAllConnections()
        })
      })
    })
    server.once('error', reject)
    injectWebSocket(server)
  })
}

// Hash both inputs to fixed-length buffers before the constant-time comparison.
function tokenMatches(header: string | undefined, token: string): boolean {
  const digest = (value: string) => createHash('sha256').update(value).digest()
  return timingSafeEqual(digest(header ?? ''), digest(`Bearer ${token}`))
}
