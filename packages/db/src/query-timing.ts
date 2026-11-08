import { AsyncLocalStorage } from 'node:async_hooks'

export interface RequestQueryTiming {
  queryCount: number
  dbTimeMs: number
  route(): string
}

export const requestQueryTiming = new AsyncLocalStorage<RequestQueryTiming>()

export const DEFAULT_SLOW_QUERY_MS = 200

async function timeQuery<T>(sql: string, slowQueryMs: number, run: () => Promise<T>): Promise<T> {
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
    if (durationMs > slowQueryMs) {
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
export function timedDriver<T extends object>(client: T, slowQueryMs: number): T {
  return new Proxy(client, {
    get(target, key) {
      const value: unknown = Reflect.get(target, key, target)
      if (typeof value !== 'function') return value
      if (key === 'query') {
        return (query: string | { text: string }, ...args: unknown[]) => timeQuery(
          typeof query === 'string' ? query : query.text,
          slowQueryMs,
          () => value.call(target, query, ...args)
        )
      }
      if (key === 'connect') {
        return async () => timedDriver(await value.call(target), slowQueryMs)
      }
      if (key === 'transaction') {
        return (callback: (tx: object) => unknown, ...args: unknown[]) => value.call(
          target, (tx: object) => callback(timedDriver(tx, slowQueryMs)), ...args
        )
      }
      return value.bind(target)
    }
  })
}
