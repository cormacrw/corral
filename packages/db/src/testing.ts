import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { openDatabase, type DatabaseHandle } from './client.ts'

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
  await withAdmin(adminUrl, admin => admin.query(`create database ${name}`))
  const url = new URL(adminUrl)
  url.pathname = `/${name}`

  const handle = await openDatabase({ driver: 'postgres', url: url.href })
  return {
    db: handle.db,
    async close() {
      await handle.close()
      // pg.Pool.end resolves before every client's socket has finished closing.
      // Let Postgres wait for those disconnects; FORCE can kill an ending client
      // and emit an uncaught 57P01 error after all assertions have passed.
      await withAdmin(adminUrl, admin => admin.query(`drop database if exists ${name}`))
    }
  }
}

// Whether the Postgres-only tests can run here
export const postgresAvailable = Boolean(process.env.CORRAL_DATABASE_URL)

async function withAdmin(url: string, fn: (client: pg.Client) => Promise<unknown>): Promise<void> {
  const client = new pg.Client({ connectionString: url })
  await client.connect()
  try {
    await fn(client)
  } finally {
    await client.end()
  }
}
