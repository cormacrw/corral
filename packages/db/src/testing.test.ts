import { sql } from 'drizzle-orm'
import pg from 'pg'
import { expect, it } from 'vitest'
import type { DatabaseHandle } from './client.ts'
import { migrationsFolder } from './client.ts'
import { createTestDatabase, requireDatabase } from './testing.ts'

it('waits for a disconnect instead of terminating a closing database client', async (context) => {
  requireDatabase('postgres', context)
  const handle = await createTestDatabase('postgres')
  if (!handle) throw new Error('Postgres test setup is required')
  const result = await handle.db.execute(sql`select current_database() as name`) as { rows: { name: string }[] }
  const url = new URL(process.env.CORRAL_DATABASE_URL!)
  url.pathname = `/${result.rows[0]!.name}`
  const client = new pg.Client({ connectionString: url.href })
  const errors: Error[] = []
  client.on('error', error => errors.push(error))
  await client.connect()

  // Reproduce a client still disconnecting when the pool has finished ending.
  const disconnected = new Promise<void>((resolve, reject) => {
    setTimeout(() => {
      client.end().then(resolve, reject)
    }, 100)
  })
  try {
    await handle.close()
    await disconnected
    expect(errors).toEqual([])
  } finally {
    await client.end()
  }
}, 30_000)

async function tableCounts(handle: DatabaseHandle): Promise<{ migrations: number, projects: number }> {
  const count = async (table: string) => {
    const { rows } = await handle.db.execute(sql.raw(`select count(*)::int as n from ${table}`)) as unknown as { rows: { n: number }[] }
    return rows[0]!.n
  }
  return { migrations: await count('drizzle.__drizzle_migrations'), projects: await count('projects') }
}

async function journalEntries(): Promise<number> {
  const { readFile } = await import('node:fs/promises')
  const journal = JSON.parse(await readFile(`${migrationsFolder}/meta/_journal.json`, 'utf8')) as { entries: unknown[] }
  return journal.entries.length
}

it.for([{ driver: 'pglite' as const }, { driver: 'postgres' as const }])('gives each $driver database every migration and none of the rows of another', async ({ driver }, context) => {
  requireDatabase(driver, context)
  const first = driver === 'pglite' ? await createTestDatabase('pglite') : (await createTestDatabase('postgres'))!
  try {
    const applied = await journalEntries()
    expect(await tableCounts(first)).toEqual({ migrations: applied, projects: 0 })
    await first.db.execute(sql`insert into projects (slug, name, prefix, repository, default_branch) values ('isolated', 'Isolated', 'ISO', 'owner/isolated', 'main')`)
    expect((await tableCounts(first)).projects).toBe(1)

    // Made while the first has rows, so a shared original would show them
    const second = driver === 'pglite' ? await createTestDatabase('pglite') : (await createTestDatabase('postgres'))!
    try {
      expect(await tableCounts(second)).toEqual({ migrations: applied, projects: 0 })
    } finally {
      await second.close()
    }
  } finally {
    await first.close()
  }
}, 30_000)

it('never leaves a connection on the template, which would block every copy', async (context) => {
  requireDatabase('postgres', context)
  const handle = (await createTestDatabase('postgres'))!
  const admin = new pg.Client({ connectionString: process.env.CORRAL_DATABASE_URL })
  await admin.connect()
  try {
    const { rows } = await admin.query<{ datname: string }>(`
      select d.datname from pg_database d
      join pg_stat_activity a on a.datname = d.datname
      where d.datname like 'corral\\_template\\_%' and a.backend_type = 'client backend'`)
    expect(rows).toEqual([])
  } finally {
    await admin.end()
    await handle.close()
  }
}, 30_000)
