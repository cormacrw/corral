import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { beforeAll, beforeEach, type TestContext } from 'vitest'
import { openDatabase, type DatabaseHandle } from './client.ts'
import { attemptAll, operationError, runAll } from './failures.ts'

// A fresh, migrated, throwaway database for one test file.
//
// `pglite` is in memory. `postgres` creates a uniquely named database on the
// server at CORRAL_DATABASE_URL and drops it on close; it's null when that
// variable is unset, so callers can skip. Anything that depends on
// concurrency must use `postgres` (D14).
export async function createTestDatabase(driver: 'pglite'): Promise<DatabaseHandle>
export async function createTestDatabase(driver: 'postgres'): Promise<DatabaseHandle | null>
export async function createTestDatabase(driver: 'pglite' | 'postgres'): Promise<DatabaseHandle | null> {
  if (driver === 'pglite') return openDatabase({ driver: 'pglite', dataDir: null })

  const adminUrl = process.env.CORRAL_DATABASE_URL
  if (!adminUrl) return null

  const name = `corral_test_${randomUUID().replaceAll('-', '')}`
  const drop = () => withAdmin(
    adminUrl,
    `Dropping test database ${name}`,
    admin => admin.query(`drop database if exists ${name} with (force)`)
  )

  // Only this run's generated database is ever dropped, and only once it exists
  let created = false
  try {
    const url = new URL(adminUrl)
    url.pathname = `/${name}`
    await withAdmin(adminUrl, `Creating test database ${name}`, async (admin) => {
      await admin.query(`create database ${name}`)
      created = true
    })

    const handle = await openDatabase({ driver: 'postgres', url: url.href })
    return {
      db: handle.db,
      close: () => runAll(`Closing test database ${name}`, adminUrl, [() => handle.close(), drop])
    }
  } catch (error) {
    throw operationError(
      `Initialising test database ${name}`,
      error,
      await attemptAll(created ? [drop] : []),
      adminUrl
    )
  }
}

// Read at hook/test execution, never at import time. A configured but broken
// database must fail, rather than silently skip (D14).
export function requireDatabase(driver: 'pglite' | 'postgres', context: Pick<TestContext, 'skip'>): void {
  if (driver === 'postgres' && !process.env.CORRAL_DATABASE_URL) {
    context.skip('Postgres requires CORRAL_DATABASE_URL (D14)')
  }
}

// Suite setup stays once per suite; skipping happens in a test hook so Vitest
// reports each unavailable test as skipped rather than passed or failed.
export function databaseFixture(driver: 'pglite' | 'postgres', setup: () => Promise<void>): void {
  beforeAll(async () => {
    if (driver === 'postgres' && !process.env.CORRAL_DATABASE_URL) return
    await setup()
  })
  beforeEach(({ skip }) => requireDatabase(driver, { skip }))
}

async function withAdmin(url: string, operation: string, fn: (client: pg.Client) => Promise<unknown>): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await runAll(operation, url, [
    async () => {
      await client.connect()
      await fn(client)
    },
    () => client.end()
  ])
}
