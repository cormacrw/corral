import { databaseLocation, openDatabase } from '@corral/db'
import { formatDuration, printReady, redactUrl, shortenHome } from './banner.ts'
import { loadConfig } from './config.ts'
import { EventBus } from './events.ts'
import { ensureOwner } from './owner.ts'
import { RunnerHub } from './runner-hub.ts'
import { startServer } from './server.ts'

const config = loadConfig()

// Opening the database applies pending migrations (D14)
const location = databaseLocation(config.databaseUrl, config.dataDir)
const database = await openDatabase(location)
const events = new EventBus()
const runner = new RunnerHub(events)

const server = await startServer(
  { db: database.db, events, actor: await ensureOwner(database.db), runner },
  { host: config.host, port: config.port }
)
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
    void server.close().finally(() => database.close().finally(() => process.exit(0)))
  })
}
