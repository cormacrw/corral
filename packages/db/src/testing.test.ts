import { sql } from 'drizzle-orm'
import pg from 'pg'
import { expect, it } from 'vitest'
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
