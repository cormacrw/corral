import EmbeddedPostgres from 'embedded-postgres'
import { mkdtemp, rm } from 'node:fs/promises'
import { createServer } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Vitest global setup: makes real Postgres available to every test file, so
// tests that depend on concurrency run locally and in the runner container,
// not only in CI (D14). CI already sets CORRAL_DATABASE_URL to its service
// container, so this does nothing there.
export default async function setup(): Promise<(() => Promise<void>) | void> {
  if (process.env.CORRAL_DATABASE_URL) return

  const dataDir = await mkdtemp(join(tmpdir(), 'corral-test-pg-'))
  const port = await freePort()
  const postgres = new EmbeddedPostgres({
    databaseDir: dataDir,
    port,
    user: 'postgres',
    password: 'postgres',
    persistent: false,
    onLog: () => {},
    onError: () => {}
  })
  await postgres.initialise()
  await postgres.start()

  // Test workers start after this and inherit it; createTestDatabase reads it
  process.env.CORRAL_DATABASE_URL = `postgres://postgres:postgres@127.0.0.1:${port}/postgres`

  return async () => {
    await postgres.stop()
    await rm(dataDir, { recursive: true, force: true })
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      probe.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(new Error('No free port')))
    })
  })
}
