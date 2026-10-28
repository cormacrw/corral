import { databaseLocation, openDatabase } from '@corral/db'
import { serve } from '@hono/node-server'
import { createApp } from './app.ts'
import { formatDuration, printReady, redactUrl, shortenHome } from './banner.ts'
import { loadConfig } from './config.ts'

const config = loadConfig()

// Opening the database applies pending migrations (D14)
const location = databaseLocation(config.databaseUrl, config.dataDir)
const database = await openDatabase(location)

const server = serve({ fetch: createApp().fetch, hostname: config.host, port: config.port }, (info) => {
  printReady(`Corral API ready in ${formatDuration(process.uptime() * 1000)}`, {
    API: `http://${info.address}:${info.port}/api`,
    Database: location.driver === 'postgres'
      ? `Postgres ${redactUrl(location.url)}`
      : `PGlite ${shortenHome(location.dataDir ?? 'in memory')}`
  })
})

// Docker sends SIGTERM on stop; close the listener so in-flight requests
// finish, then close the database so PGlite flushes to disk
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    server.close(() => {
      database.close().finally(() => process.exit(0))
    })
  })
}
