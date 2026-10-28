import { RUNNER_PATH } from '@corral/contracts'
import { serve, type ServerType } from '@hono/node-server'
import { createNodeWebSocket } from '@hono/node-ws'
import { Hono } from 'hono'
import type { AddressInfo } from 'node:net'
import { createApp, type AppDeps } from './app.ts'

export interface RunningServer {
  url: string
  close(): Promise<void>
}

// The HTTP API under /api plus the runner WebSocket at /runner. Only /api is
// proxied by web, so the runner socket stays on the private network (D12).
export function startServer(deps: AppDeps, options: { host: string, port: number }): Promise<RunningServer> {
  const root = new Hono()
  const { injectWebSocket, upgradeWebSocket } = createNodeWebSocket({ app: root })

  root.get(RUNNER_PATH, upgradeWebSocket(() => {
    let connection: ReturnType<AppDeps['runner']['connect']> | null = null
    return {
      onOpen: (_event, ws) => {
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
  root.route('/', createApp(deps))

  return new Promise((resolve) => {
    const server: ServerType = serve({ fetch: root.fetch, hostname: options.host, port: options.port }, (info: AddressInfo) => {
      resolve({
        url: `http://${info.address.includes(':') ? `[${info.address}]` : info.address}:${info.port}`,
        close: () => new Promise(done => server.close(() => done()))
      })
    })
    injectWebSocket(server)
  })
}
