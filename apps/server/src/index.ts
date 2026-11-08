import { databaseLocation, openDatabase, schema } from '@corral/db'
import { join } from 'node:path'
import { formatDuration, printReady, redactUrl, shortenHome } from './banner.ts'
import { boot } from './boot.ts'
import { loadConfig } from './config.ts'
import { EventBus } from './events.ts'
import type { RunningServer } from './server.ts'

// Node's default is to exit. Every known source handles its own failure, so
// one that gets through must not drop open tool calls and every runner with it.
process.on('unhandledRejection', (reason) => {
  console.error('Unhandled rejection', reason)
})

const config = loadConfig()

// Opening the database applies pending migrations (D14)
const location = databaseLocation(config.databaseUrl, config.dataDir)
const database = await openDatabase(location, { slowQueryMs: config.slowQueryMs })
// Only a demo instance loads the demo code (`pnpm dev:demo`)
const demo = config.demo
  ? { ...await import('./demo/demo-github.ts'), ...await import('./demo/demo-runner.ts') }
  : undefined
const booted = await boot({
  db: database.db,
  events: new EventBus(),
  spoolDir: join(config.dataDir, 'spool'),
  blobDir: join(config.dataDir, 'blobs'),
  publicUrl: config.publicUrl,
  buildSha: config.buildSha,
  slowRequestMs: config.slowRequestMs,
  // A demo instance (`pnpm dev:demo`) talks to a saved fake GitHub, never the real one
  ...(demo && { github: demo.DemoGitHub.load(config.dataDir) }),
  listeners: [
    { host: config.host, port: config.port },
    ...(config.runnerListen ? [{ ...config.runnerListen, runnerOnly: true }] : [])
  ],
  runnerToken: config.runnerToken,
  start: true
})
const [server, runnerServer] = booted.servers as [RunningServer, RunningServer | undefined]
const stopDemoRunner = demo
  ? await demo.startDemoRunner(server.url, async () => (await database.db.select({ repository: schema.projects.repository }).from(schema.projects)).map(p => p.repository))
  : undefined
printReady(`Corral API ready in ${formatDuration(process.uptime() * 1000)}`, {
  API: `${server.url}/api`,
  Runner: `${server.url.replace(/^http/, 'ws')}/runner`,
  ...(runnerServer ? { 'Tailnet runner': `${runnerServer.url.replace(/^http/, 'ws')}/runner` } : {}),
  ...(demo ? { Demo: 'fake GitHub and a PM-only demo runner; no agent work starts' } : {}),
  Database: location.driver === 'postgres'
    ? `Postgres ${redactUrl(location.url)}`
    : `PGlite ${shortenHome(location.dataDir ?? 'in memory')}`
})

// Docker sends SIGTERM on stop; close the listener so in-flight requests
// finish, then close the database so PGlite flushes to disk
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    const stopping = booted.stop()
    stopDemoRunner?.()
    void stopping.finally(() => database.close().finally(() => process.exit(0)))
    // Never hang a stop: if something above doesn't finish, exit anyway
    setTimeout(() => process.exit(0), 5000).unref()
  })
}
