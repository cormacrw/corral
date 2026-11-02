import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestQueryTiming {
  queryCount: number
  dbTimeMs: number
  route(): string
}

export const requestQueryTiming = new AsyncLocalStorage<RequestQueryTiming>()

function slowQueryThreshold(): number {
  const value = process.env.CORRAL_SLOW_QUERY_MS
  const threshold = value === undefined ? 200 : Number(value)
  return Number.isFinite(threshold) && threshold >= 0 ? threshold : 200
}

async function timeQuery<T>(sql: string, run: () => Promise<T>): Promise<T> {
  const request = requestQueryTiming.getStore()
  const start = performance.now()
  try {
    return await run()
  } finally {
    const durationMs = performance.now() - start
    if (request) {
      request.queryCount++
      request.dbTimeMs += durationMs
    }
    if (durationMs > slowQueryThreshold()) {
      console.warn('Slow database query', {
        sql,
        durationMs: Number(durationMs.toFixed(3)),
        ...(request ? { route: request.route() } : {})
      })
    }
  }
}

// Drizzle calls the promise-based driver API. Preserve the real receiver for
// driver internals, and wrap acquired transaction clients as well as the pool.
export function timedDriver<T extends object>(client: T): T {
  return new Proxy(client, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      if (key === 'query') {
        return (query: string | { text: string }, ...args: unknown[]) => timeQuery(
          typeof query === 'string' ? query : query.text,
          () => value.call(target, query, ...args)
        )
      }
      if (key === 'connect') {
        return async () => timedDriver(await value.call(target))
      }
      if (key === 'transaction') {
        return (callback: (tx: object) => unknown, ...args: unknown[]) => value.call(
          target, (tx: object) => callback(timedDriver(tx)), ...args
        )
      }
      return value.bind(target)
    }
  })
}
