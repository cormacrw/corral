import { schema, type DatabaseHandle } from '@corral/db'
import { createTestDatabase } from '@corral/db/testing'
import { Hono } from 'hono'
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import { apiTiming, PerformanceSamples } from './performance.ts'
import { createTestApp, type TestApp } from './test-app.ts'

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
})

describe('API timing', () => {
  let t: TestApp

  beforeAll(async () => {
    t = await createTestApp('pglite')
  })

  afterAll(async () => {
    await t?.close()
  })

  it('records real API successes, validation and errors using patterns and the header duration', async () => {
    const paths = ['/api/runner', '/api/tasks/PRIVATE-123?secret=hidden', '/api/projects/private-id', '/api/unknown-private-id', '/api/designs/private-version/files/index.html']
    const responses: Response[] = []
    for (const path of paths) responses.push(await t.request('GET', path))
    responses.push(await t.request('POST', '/api/projects', {}))
    await t.performance.flush()
    const rows = await t.db.select().from(schema.perfSamples)
    expect(rows.map(r => r.name)).toEqual(['/api/runner', '/api/tasks/:ref', '/api/projects/:slug', '/api/*', '/api/designs/:versionId/files/*', '/api/projects'])
    rows.forEach((row, i) => {
      expect(row.kind).toBe('api')
      expect(row.status).toBe(responses[i]!.status)
      expect(row.durationMs).toBeGreaterThanOrEqual(0)
      expect(responses[i]!.headers.get('server-timing')).toBe(`total;dur=${row.durationMs}, db;dur=${row.dbTimeMs};desc="${row.queryCount} queries"`)
    })
    const health = await t.request('GET', '/api/health')
    const sse = await t.request('GET', '/api/events')
    expect(health.headers.get('server-timing')).toMatch(/^total;dur=/)
    expect(sse.headers.get('server-timing')).toMatch(/^total;dur=/)
    await sse.body!.cancel()
    await t.performance.flush()
    expect(await t.db.select().from(schema.perfSamples)).toHaveLength(6)
  })
})

describe('performance sample recorder', () => {
  let handle: DatabaseHandle

  beforeAll(async () => {
    handle = await createTestDatabase('pglite')
  })

  afterAll(async () => {
    await handle?.close()
  })

  it('defers and batches writes, warns once only above threshold, excludes upgrades and prunes on its timer', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] })
    const samples = new PerformanceSamples(handle.db, '10')
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
    let clock = 0
    vi.spyOn(performance, 'now').mockImplementation(() => clock)
    const app = new Hono().basePath('/api').use('*', apiTiming(samples))
      .get('/fast/:id', (c) => {
        clock += 5
        return c.json({ ok: true })
      })
      .get('/slow/:id', (c) => {
        clock += 15
        return c.json({ ok: true })
      })
      .get('/broken/:id', () => {
        clock += 20
        throw new Error('broken')
      })
      .onError((_error, c) => c.json({ error: 'broken' }, 500))
    try {
      const fast = await app.request('/api/fast/secret')
      expect(fast.headers.get('server-timing')).toBe('total;dur=5, db;dur=0;desc="0 queries"')
      expect(warn).not.toHaveBeenCalled()
      const slow = await app.request('/api/slow/secret')
      expect(slow.headers.get('server-timing')).toBe('total;dur=15, db;dur=0;desc="0 queries"')
      expect(warn).toHaveBeenCalledExactlyOnceWith('Slow API request: method=GET route=/api/slow/:id status=200 durationMs=15')
      await app.request('/api/broken/secret')
      expect(warn).toHaveBeenLastCalledWith('Slow API request: method=GET route=/api/broken/:id status=500 durationMs=20')
      await app.request('/api/slow/secret', { headers: { upgrade: 'websocket' } })
      expect(warn).toHaveBeenCalledTimes(2)
      // Even completed responses have not written to the database yet.
      expect(await handle.db.select().from(schema.perfSamples)).toEqual([])
      const insert = vi.spyOn(handle.db, 'insert')
      await vi.advanceTimersByTimeAsync(1000)
      await samples.flush()
      expect(insert).toHaveBeenCalledTimes(1)
      expect(await handle.db.select().from(schema.perfSamples)).toHaveLength(3)
      const now = Date.now()
      await handle.db.insert(schema.perfSamples).values([
        { kind: 'api', name: 'expired', durationMs: 1, createdAt: new Date(now - 8 * 86400000) },
        { kind: 'page', name: 'recent', durationMs: 1, createdAt: new Date(now - 6 * 86400000) }
      ])
      await vi.advanceTimersByTimeAsync(60_000)
      await samples.prune()
      const names = (await handle.db.select().from(schema.perfSamples)).map(r => r.name)
      expect(names).not.toContain('expired')
      expect(names).toContain('recent')
    } finally {
      await samples.stop()
    }
  })
})
