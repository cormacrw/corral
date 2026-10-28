import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { loadConfig } from './config.ts'

const config = loadConfig()

const server = serve({ fetch: createApp().fetch, hostname: config.host, port: config.port }, (info) => {
  console.log(`corral server listening on http://${info.address}:${info.port} (data: ${config.dataDir})`)
})

// Docker sends SIGTERM on stop; close the listener so in-flight requests finish
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => process.exit(0))
  })
}
