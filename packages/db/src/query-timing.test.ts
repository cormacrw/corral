import { sql } from 'drizzle-orm'
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest'
import type { DatabaseHandle } from './client.ts'
import { requestQueryTiming } from './query-timing.ts'
import { createTestDatabase, databaseFixture } from './testing.ts'

afterEach(() => {
  vi.restoreAllMocks()
  vi.unstubAllEnvs()
})

for (const driver of ['pglite', 'postgres'] as const) {
  describe(`${driver} query timing`, () => {
    let handle: DatabaseHandle
    databaseFixture(driver, async () => {
      handle = (driver === 'pglite' ? await createTestDatabase('pglite') : await createTestDatabase('postgres'))!
    })
    afterAll(async () => {
      await handle?.close()
    })

    it('isolates concurrent contexts and measures prepared queries, transactions and failures', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      vi.stubEnv('CORRAL_SLOW_QUERY_MS', '0')
      const first = { queryCount: 0, dbTimeMs: 0, route: () => '/api/first/:id' }
      const second = { queryCount: 0, dbTimeMs: 0, route: () => '/api/second' }
      await Promise.all([
        requestQueryTiming.run(first, async () => {
          await handle.db.execute(sql`select ${'PRIVATE-VALUE'}::text`)
          await expect(handle.db.execute(sql`select missing_column`)).rejects.toThrow()
        }),
        requestQueryTiming.run(second, async () => {
          await handle.db.transaction(async (tx) => {
            await tx.execute(sql`select 1`)
          })
        })
      ])
      expect(first.queryCount).toBe(2)
      // Postgres emits BEGIN/COMMIT through query(); PGlite manages them internally.
      expect(second.queryCount).toBe(driver === 'postgres' ? 3 : 1)
      expect(first.dbTimeMs).toBeGreaterThan(0)
      expect(second.dbTimeMs).toBeGreaterThan(0)
      expect(warn.mock.calls.some(call => JSON.stringify(call).includes('PRIVATE-VALUE'))).toBe(false)
      expect(warn.mock.calls.some(call => call[1].route === '/api/first/:id')).toBe(true)
      await handle.db.execute(sql`select 2`)
      expect(warn.mock.lastCall?.[1]).not.toHaveProperty('route')
      expect(first.queryCount).toBe(2)
    })

    it('uses the default threshold for invalid configuration and counts prepared executions', async () => {
      vi.stubEnv('CORRAL_SLOW_QUERY_MS', '-1')
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      let clock = 0
      vi.spyOn(performance, 'now').mockImplementation(() => {
        clock += 100
        return clock
      })
      const timing = { queryCount: 0, dbTimeMs: 0, route: () => '/api/prepared' }
      const prepared = handle.db.select().from((await import('./schema.ts')).settings).prepare('timing_test')
      await requestQueryTiming.run(timing, async () => {
        await prepared.execute()
        await prepared.execute()
      })
      expect(timing).toMatchObject({ queryCount: 2, dbTimeMs: 200 })
      expect(warn).not.toHaveBeenCalled()
    })
  })
}
