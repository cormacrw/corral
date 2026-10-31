import { PGlite } from '@electric-sql/pglite'
import { drizzle } from 'drizzle-orm/pglite'
import { migrate } from 'drizzle-orm/pglite/migrator'
import { createHash, randomUUID } from 'node:crypto'
import { mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { join, relative } from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import pg from 'pg'
import { beforeAll, beforeEach, type TestContext } from 'vitest'
import { migrationsFolder, openDatabase, type DatabaseHandle } from './client.ts'
import { attemptAll, operationError, runAll } from './failures.ts'

// A fresh, migrated, throwaway database for one test file.
//
// `pglite` is in memory. `postgres` creates a uniquely named database on the
// server at CORRAL_DATABASE_URL and drops it on close; it's null when that
// variable is unset, so callers can skip. Anything that depends on
// concurrency must use `postgres` (D14).
//
// Running every migration for each database is the slowest part of the suites,
// so both drivers start from a copy of a migrated database instead. Nothing
// writes to the copied original, and its name hashes the migrations, so a new
// migration builds a new one. `openDatabase` still runs on each copy.
export async function createTestDatabase(driver: 'pglite'): Promise<DatabaseHandle>
export async function createTestDatabase(driver: 'postgres'): Promise<DatabaseHandle | null>
export async function createTestDatabase(driver: 'pglite' | 'postgres'): Promise<DatabaseHandle | null> {
  if (driver === 'pglite') {
    return openDatabase({ driver: 'pglite', dataDir: null, loadDataDir: await migratedPglite() })
  }

  const adminUrl = process.env.CORRAL_DATABASE_URL
  if (!adminUrl) return null

  const name = `corral_test_${randomUUID().replaceAll('-', '')}`
  // Wait for pool sockets to disconnect; FORCE can emit uncaught 57P01 errors.
  const drop = () => withAdmin(
    adminUrl,
    `Dropping test database ${name}`,
    admin => admin.query(`drop database if exists ${name}`)
  )

  // Only this run's generated database is ever dropped, and only once it exists
  let created = false
  try {
    const url = new URL(adminUrl)
    url.pathname = `/${name}`
    await withAdmin(adminUrl, `Creating test database ${name}`, async (admin) => {
      const template = await migratedTemplate(admin, adminUrl)
      await whileInUse(() => admin.query(`create database ${name} template ${template}`))
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

// A hash of every migration file
async function migrationsKey(): Promise<string> {
  const entries = await readdir(migrationsFolder, { recursive: true, withFileTypes: true })
  const files = entries.filter(entry => entry.isFile()).map(entry => join(entry.parentPath, entry.name)).sort()
  const hash = createHash('sha256')
  for (const file of files) hash.update(relative(migrationsFolder, file)).update(await readFile(file))
  return hash.digest('hex').slice(0, 16)
}

// Any value: only needs to differ from other advisory locks on the server
const templateLock = 7_241_903

// The database every test database copies, built once for each set of
// migrations and only ever connected to while it's built. Nothing cleans up a
// template from older migrations; each is one small database.
async function migratedTemplate(admin: pg.Client, adminUrl: string): Promise<string> {
  const template = `corral_template_${await migrationsKey()}`
  const exists = async () => (await admin.query('select 1 from pg_database where datname = $1', [template])).rowCount === 1
  if (await exists()) return template

  // Built under another name, so a template that exists is always complete
  const building = `${template}_building`
  await admin.query('select pg_advisory_lock($1)', [templateLock])
  try {
    if (await exists()) return template
    // Left by a run that was killed; holding the lock proves it's dead
    await admin.query(`drop database if exists ${building}`)
    await admin.query(`create database ${building}`)
    try {
      const url = new URL(adminUrl)
      url.pathname = `/${building}`
      const handle = await openDatabase({ driver: 'postgres', url: url.href })
      await handle.close()
      await whileInUse(() => admin.query(`alter database ${building} rename to ${template}`))
    } catch (error) {
      await attemptAll([() => admin.query(`drop database if exists ${building}`)])
      throw error
    }
    return template
  } finally {
    await admin.query('select pg_advisory_unlock($1)', [templateLock])
  }
}

// pg.Pool.end can resolve before its sockets disconnect, and autovacuum can
// visit a template: both make Postgres refuse with "being accessed by other
// users" for a moment
async function whileInUse<T>(work: () => Promise<T>): Promise<T> {
  for (let tries = 1; ; tries++) {
    try {
      return await work()
    } catch (error) {
      if ((error as { code?: string }).code !== '55006' || tries === 20) throw error
      await sleep(100)
    }
  }
}

let pgliteDump: Promise<Blob> | undefined

function migratedPglite(): Promise<Blob> {
  pgliteDump ??= loadPgliteDump()
  return pgliteDump
}

// A dump of a migrated PGlite, on disk because each test file has its own copy
// of this module. It depends on the PGlite build as well as the migrations.
async function loadPgliteDump(): Promise<Blob> {
  const build = createRequire(import.meta.url).resolve('@electric-sql/pglite')
  const key = createHash('sha256').update(await migrationsKey()).update(build).digest('hex').slice(0, 16)
  const dir = join(import.meta.dirname, '..', 'node_modules', '.cache', 'corral')
  const name = `pglite-${key}.tar`
  const cached = await readFile(join(dir, name)).catch(() => null)
  if (cached) return new Blob([cached])

  const client = new PGlite()
  try {
    await migrate(drizzle(client), { migrationsFolder })
    const dump = await client.dumpDataDir('none')
    await mkdir(dir, { recursive: true })
    // Renamed into place: workers race here, and half a dump must never load
    const partial = join(dir, `${name}.${randomUUID()}`)
    await writeFile(partial, await dump.bytes())
    await rename(partial, join(dir, name))
    const stale = (await readdir(dir)).filter(file => file.startsWith('pglite-') && file.endsWith('.tar') && file !== name)
    await Promise.all(stale.map(file => rm(join(dir, file), { force: true })))
    return dump
  } finally {
    await client.close()
  }
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
