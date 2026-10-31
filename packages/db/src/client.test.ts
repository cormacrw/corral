import { sql } from 'drizzle-orm'
import pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { createTestDatabase, requireDatabase } from './testing.ts'

afterEach(() => {
  vi.restoreAllMocks()
})

it('survives an idle Postgres connection dropping, and bounds its statements', async (context) => {
  requireDatabase('postgres', context)
  const handle = await createTestDatabase('postgres')
  if (!handle) throw new Error('Postgres test setup is required')
  const logged = vi.spyOn(console, 'error').mockImplementation(() => {})
  try {
    const result = await handle.db.execute(sql`select current_database() as name, pg_backend_pid() as pid, current_setting('statement_timeout') as timeout`) as { rows: { name: string, pid: number, timeout: string }[] }
    const { name, pid, timeout } = result.rows[0]!
    expect(timeout).toBe('3min')

    const url = new URL(process.env.CORRAL_DATABASE_URL!)
    url.pathname = `/${name}`
    const admin = new pg.Client({ connectionString: url.href })
    await admin.connect()
    await admin.query('select pg_terminate_backend($1)', [pid])
    await admin.end()

    // With no listener this is an uncaught exception, which fails the run
    await vi.waitFor(() => expect(logged).toHaveBeenCalledWith('Idle Postgres connection failed', expect.any(Error)))
    await expect(handle.db.execute(sql`select 1`)).resolves.toBeDefined()
  } finally {
    await handle.close()
  }
})
