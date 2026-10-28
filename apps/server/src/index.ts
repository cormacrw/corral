import { databaseLocation, openDatabase } from '@corral/db'
import { join } from 'node:path'
import { formatDuration, printReady, redactUrl, shortenHome } from './banner.ts'
import { ensureAgents, ensureOwner } from './bootstrap.ts'
import { loadConfig } from './config.ts'
import { EventBus } from './events.ts'
import { startServer } from './server.ts'
import { createServices } from './services.ts'

const config = loadConfig()

// Opening the database applies pending migrations (D14)
const location = databaseLocation(config.databaseUrl, config.dataDir)
const database = await openDatabase(location)
const events = new EventBus()
await ensureAgents(database.db)
const services = createServices({
  db: database.db,
  events,
  spoolDir: join(config.dataDir, 'spool'),
  blobDir: join(config.dataDir, 'blobs'),
  publicUrl: config.publicUrl
})

const server = await startServer(
  { db: database.db, events, actor: await ensureOwner(database.db), ...services },
  { host: config.host, port: config.port }
)
await services.orchestrator.init()
services.orchestrator.start()
printReady(`Corral API ready in ${formatDuration(process.uptime() * 1000)}`, {
  API: `${server.url}/api`,
  Runner: `${server.url.replace(/^http/, 'ws')}/runner`,
  Database: location.driver === 'postgres'
    ? `Postgres ${redactUrl(location.url)}`
    : `PGlite ${shortenHome(location.dataDir ?? 'in memory')}`
})

// Docker sends SIGTERM on stop; close the listener so in-flight requests
// finish, then close the database so PGlite flushes to disk
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    services.orchestrator.stop()
    void server.close().finally(() => database.close().finally(() => process.exit(0)))
  })
}
