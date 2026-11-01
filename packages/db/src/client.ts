import { PGlite } from '@electric-sql/pglite'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres'
import { migrate as migrateNodePg } from 'drizzle-orm/node-postgres/migrator'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import { attemptAll, operationError } from './failures.ts'
import * as schema from './schema.ts'
import { timedDriver } from './query-timing.ts'

// Postgres when deployed and in CI; PGlite in development and tests (D14)
export type DatabaseLocation =
  | { driver: 'postgres', url: string }
  // `dataDir: null` keeps the database in memory. `loadDataDir` starts it from
  // a dump of a migrated instance (tests only), which is much faster.
  | { driver: 'pglite', dataDir: string | null, loadDataDir?: Blob }

// Both drivers share this type, so nothing above packages/db knows which is in use
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
// Anything queries can run on: the database or an open transaction
export type Executor = Database | Transaction

export interface DatabaseHandle {
  db: Database
  close(): Promise<void>
}

export const migrationsFolder = join(import.meta.dirname, '..', 'migrations')
const casing = 'snake_case'

// Neither driver surfaces a notice nobody listens for, and migrations report
// preserved history with RAISE WARNING, so warnings go to the server's output.
// Lower severities are routine ("schema already exists, skipping").
function reportWarning(notice: { severity?: string | undefined, message?: string | undefined }) {
  if (notice.severity === 'WARNING') console.warn(`Database warning: ${notice.message}`)
}

// PGlite takes its notice listener per call, not per client
function reportPgliteWarnings(client: PGlite) {
  const execProtocol = client.execProtocol.bind(client)
  client.execProtocol = (message, options) => execProtocol(message, { ...options, onNotice: reportWarning })
  const execProtocolStream = client.execProtocolStream.bind(client)
  client.execProtocolStream = (message, options) => execProtocolStream(message, { ...options, onNotice: reportWarning })
}

// Waiting for a free connection, so a stuck pool fails a pass instead of hanging it
const CONNECTION_TIMEOUT_MS = 30_000
// Longer than the 15 s tick, so connections are reused between ticks
const IDLE_TIMEOUT_MS = 60_000
// Waiting for a row lock counts, and a merge holds one across GitHub calls of
// up to 60 s each: the merge and re-reading the PR, plus a little
const STATEMENT_TIMEOUT_MS = 180_000

// An idle connection dropping (a Postgres restart) is emitted on the pool, and
// with no listener that's an uncaught exception. The pool replaces it.
function postgresPool(connectionString: string, limits: pg.PoolConfig = {}): pg.Pool {
  const pool = new pg.Pool({ connectionString, connectionTimeoutMillis: CONNECTION_TIMEOUT_MS, idleTimeoutMillis: IDLE_TIMEOUT_MS, ...limits })
  pool.on('error', error => console.error('Idle Postgres connection failed', error))
  pool.on('connect', client => client.on('notice', reportWarning))
  return pool
}

// Opens the database and applies any pending migrations. Only apps/server
// calls this (D8).
export async function openDatabase(location: DatabaseLocation): Promise<DatabaseHandle> {
  if (location.driver === 'postgres') {
    // Migrations may take as long as they take, so they run before the limit
    const migrating = postgresPool(location.url)
    try {
      await migrateNodePg(drizzleNodePg(migrating, { schema, casing }), { migrationsFolder })
    } catch (error) {
      throw operationError('Migrating the Postgres database', error, await attemptAll([() => migrating.end()]), location.url)
    }
    await migrating.end()
    const pool = postgresPool(location.url, { statement_timeout: STATEMENT_TIMEOUT_MS })
    return { db: drizzleNodePg(timedDriver(pool), { schema, casing }), close: () => pool.end() }
  }

  // PGlite creates its own folder but not missing parents
  if (location.dataDir !== null) await mkdir(location.dataDir, { recursive: true })
  const client = location.loadDataDir
    ? new PGlite({ loadDataDir: location.loadDataDir })
    : location.dataDir === null ? new PGlite() : new PGlite(location.dataDir)
  reportPgliteWarnings(client)
  const db = drizzlePglite(timedDriver(client), { schema, casing })
  try {
    await migratePglite(db, { migrationsFolder })
  } catch (error) {
    throw operationError('Migrating the PGlite database', error, await attemptAll([() => client.close()]))
  }
  return { db, close: () => client.close() }
}

// CORRAL_DATABASE_URL set means Postgres; unset means PGlite under the
// server's data dir (D14)
export function databaseLocation(databaseUrl: string | undefined, serverDataDir: string): DatabaseLocation {
  return databaseUrl
    ? { driver: 'postgres', url: databaseUrl }
    : { driver: 'pglite', dataDir: join(serverDataDir, 'pgdata') }
}
