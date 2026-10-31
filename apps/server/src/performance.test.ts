import type { PerfSummary } from '@corral/contracts'
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

describe('performance summary', () => {
  let t: TestApp
  const ago = (minutes: number) => new Date(Date.now() - minutes * 60_000)
  const summary = async (query: string) => {
    const response = await t.request('GET', `/api/perf/summary${query}`)
    expect(response.status).toBe(200)
    return await response.json() as PerfSummary
  }

  beforeAll(async () => {
    t = await createTestApp('pglite')
  })

  afterAll(async () => {
    await t?.close()
  })

  it('is empty without samples, and rejects unknown windows', async () => {
    expect(await summary('?window=1h')).toEqual({
      window: '1h', slowThresholdMs: 500, routes: [], pages: [], vitals: { LCP: null, INP: null, CLS: null }
    })
    expect((await t.request('GET', '/api/perf/summary?window=30d')).status).toBe(400)
  })

  it('aggregates routes, pages and vitals for the window, slowest p95 first', async () => {
    await t.db.delete(schema.perfSamples)
    const session = (n: number) => `00000000-0000-4000-8000-00000000000${n}`
    const api = (name: string, durationMs: number, minutes: number, dbTimeMs: number | null = 2, queryCount: number | null = 1) =>
      ({ kind: 'api', name, durationMs, dbTimeMs, queryCount, status: 200, createdAt: ago(minutes) })
    const page = (name: string, metric: string, durationMs: number, minutes: number, sessionId = session(1)) =>
      ({ kind: 'page', name, metric, durationMs, sessionId, createdAt: ago(minutes) })
    await t.db.insert(schema.perfSamples).values([
      ...[10, 20, 30, 40, 1000].map(ms => api('/api/fast-median', ms, 5, 4, 3)),
      api('/api/fast-median', 100, 5, 2, 2),
      api('/api/steady', 300, 5, null, null),
      api('/api/old', 9000, 120),
      page('/tasks/[ref]', 'navigation', 100, 5),
      page('/tasks/[ref]', 'navigation', 300, 5),
      page('/tasks/[ref]', 'ttfb', 9000, 5),
      page('/home', 'navigation', 900, 120),
      // The first session's LCP grew, so 1000 must not count
      page('/tasks/[ref]', 'LCP', 1000, 10),
      page('/tasks/[ref]', 'LCP', 3000, 5),
      page('/home', 'LCP', 2000, 5, session(2)),
      page('/home', 'CLS', 0.2, 5, session(2))
    ])

    const hour = await summary('?window=1h')
    expect(hour.routes.map(r => r.name)).toEqual(['/api/fast-median', '/api/steady'])
    const [first, second] = hour.routes
    expect(first).toMatchObject({ count: 6, maxMs: 1000, p50Ms: 35, avgQueries: 17 / 6 })
    expect(first!.p95Ms).toBeCloseTo(775)
    expect(first!.avgDbTimeMs).toBeCloseTo(22 / 6)
    expect(second).toMatchObject({ count: 1, p95Ms: 300, avgDbTimeMs: null, avgQueries: null })
    expect(hour.pages).toEqual([{ name: '/tasks/[ref]', count: 2, p50Ms: 200, p95Ms: 290 }])
    expect(hour.vitals).toEqual({ LCP: 2750, INP: null, CLS: 0.2 })

    const day = await summary('?window=24h')
    expect(day.routes.map(r => r.name)).toEqual(['/api/old', '/api/fast-median', '/api/steady'])
    expect(day.pages.map(p => p.name)).toEqual(['/home', '/tasks/[ref]'])
    expect((await summary('')).window).toBe('24h')
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
