import { PGlite } from '@electric-sql/pglite'
import type { PgDatabase, PgQueryResultHKT } from 'drizzle-orm/pg-core'
import { drizzle as drizzleNodePg } from 'drizzle-orm/node-postgres'
import { migrate as migrateNodePg } from 'drizzle-orm/node-postgres/migrator'
import { drizzle as drizzlePglite } from 'drizzle-orm/pglite'
import { migrate as migratePglite } from 'drizzle-orm/pglite/migrator'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import pg from 'pg'
import * as schema from './schema.ts'

// Postgres when deployed and in CI; PGlite in development and tests (D14)
export type DatabaseLocation =
  | { driver: 'postgres', url: string }
  // `dataDir: null` keeps the database in memory
  | { driver: 'pglite', dataDir: string | null }

// Both drivers share this type, so nothing above packages/db knows which is in use
export type Database = PgDatabase<PgQueryResultHKT, typeof schema>
export type Transaction = Parameters<Parameters<Database['transaction']>[0]>[0]
// Anything queries can run on: the database or an open transaction
export type Executor = Database | Transaction

export interface DatabaseHandle {
  db: Database
  close(): Promise<void>
}

const migrationsFolder = join(import.meta.dirname, '..', 'migrations')
const casing = 'snake_case'

// Opens the database and applies any pending migrations. Only apps/server
// calls this (D8).
export async function openDatabase(location: DatabaseLocation): Promise<DatabaseHandle> {
  if (location.driver === 'postgres') {
    const pool = new pg.Pool({ connectionString: location.url })
    const db = drizzleNodePg(pool, { schema, casing })
    try {
      await migrateNodePg(db, { migrationsFolder })
    } catch (error) {
      await pool.end()
      throw error
    }
    return { db, close: () => pool.end() }
  }

  // PGlite creates its own folder but not missing parents
  if (location.dataDir !== null) await mkdir(location.dataDir, { recursive: true })
  const client = location.dataDir === null ? new PGlite() : new PGlite(location.dataDir)
  const db = drizzlePglite(client, { schema, casing })
  try {
    await migratePglite(db, { migrationsFolder })
  } catch (error) {
    await client.close()
    throw error
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
