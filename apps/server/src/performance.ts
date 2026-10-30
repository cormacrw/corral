import { requestQueryTiming, schema, type Database } from '@corral/db'
import { lt } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { matchedRoutes } from 'hono/route'

// Raw-path security middleware can respond before a concrete route handler.
declare module 'hono' {
  interface ContextVariableMap {
    performanceRoute?: string
  }
}

const RETENTION_MS = 7 * 24 * 60 * 60 * 1000
const BATCH_SIZE = 1000

type Sample = typeof schema.perfSamples.$inferInsert

// One recorder per service container. No database work runs on the request path.
export class PerformanceSamples {
  private pending: Sample[] = []
  private writing: Promise<void> | undefined
  private pruning: Promise<void> | undefined
  private readonly flushTimer: ReturnType<typeof setInterval>
  private readonly pruneTimer: ReturnType<typeof setInterval>
  private stopped = false
  private readonly db: Database
  readonly slowRequestMs: number

  constructor(db: Database, slowRequestMs = process.env.CORRAL_SLOW_REQUEST_MS) {
    this.db = db
    const threshold = slowRequestMs === undefined ? 500 : Number(slowRequestMs)
    this.slowRequestMs = Number.isFinite(threshold) && threshold >= 0 ? threshold : 500
    this.flushTimer = setInterval(() => {
      void this.flush()
    }, 1000).unref()
    this.pruneTimer = setInterval(() => {
      void this.prune()
    }, 60 * 1000).unref()
  }

  record(sample: Sample) {
    if (!this.stopped) this.pending.push(sample)
  }

  flush(): Promise<void> {
    if (this.writing) return this.writing
    this.writing = (async () => {
      while (this.pending.length) {
        const batch = this.pending.splice(0, BATCH_SIZE)
        try {
          await this.db.insert(schema.perfSamples).values(batch)
        } catch (error) {
          // Diagnostics must never fail a request. Drop this batch rather than
          // retry forever and accumulate memory during a database outage.
          console.error('Writing performance samples failed', error)
        }
      }
    })().finally(() => { this.writing = undefined })
    return this.writing
  }

  prune(): Promise<void> {
    if (this.pruning) return this.pruning
    this.pruning = this.db.delete(schema.perfSamples)
      .where(lt(schema.perfSamples.createdAt, new Date(Date.now() - RETENTION_MS)))
      .then(() => {}, (error) => { console.error('Pruning performance samples failed', error) })
      .finally(() => { this.pruning = undefined })
    return this.pruning
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.flushTimer)
    clearInterval(this.pruneTimer)
    await Promise.all([this.flush(), this.pruning])
  }
}

export function apiTiming(samples: PerformanceSamples): MiddlewareHandler {
  return async (c, next) => {
    const start = performance.now()
    const routePattern = () => c.get('performanceRoute') ?? matchedRoutes(c).findLast(route => route.method !== 'ALL')?.path ?? '/api/*'
    const timing = { queryCount: 0, dbTimeMs: 0, route: routePattern }
    await requestQueryTiming.run(timing, next)
    const durationMs = Number((performance.now() - start).toFixed(3))
    const dbTimeMs = Number(timing.dbTimeMs.toFixed(3))
    c.header('Server-Timing', `total;dur=${durationMs}, db;dur=${dbTimeMs};desc="${timing.queryCount} queries"`)

    // ALL routes are middleware. The last concrete handler also covers early
    // validation responses; unknown URLs retain a fixed label without IDs.
    const route = routePattern()
    const streaming = c.res.headers.get('content-type')?.split(';')[0]?.trim() === 'text/event-stream'
      || c.req.header('upgrade')?.toLowerCase() === 'websocket'
      || c.res.status === 101
    if (streaming || route === '/api/health' || route === '/api/perf/client') return

    if (durationMs > samples.slowRequestMs) {
      console.warn(`Slow API request: method=${c.req.method} route=${route} status=${c.res.status} durationMs=${durationMs}`)
    }
    samples.record({ kind: 'api', name: route, durationMs, queryCount: timing.queryCount, dbTimeMs, status: c.res.status, createdAt: new Date() })
  }
}
