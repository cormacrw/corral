import { QueryClient } from '@tanstack/vue-query'
import type { ApiErrorBody } from '@corral/contracts'

// An API failure, with the server's structured error when there is one. Pages
// tell failures apart with this; the transport itself stays in app/queries.
export class ApiError extends Error {
  status: number
  body: ApiErrorBody['error'] | null

  constructor(status: number, body: ApiErrorBody['error'] | null, message: string) {
    super(message)
    this.status = status
    this.body = body
  }
}

// The server refused a move because the task lacks what Ready needs; the
// error's message says what
export const refusedNotReady = (e: unknown): e is ApiError =>
  e instanceof ApiError && e.body?.code === 'transition_rejected' && e.body.reason.code === 'not_ready'

// What to say beside the prefix field when another project already has it
export const prefixTaken = (e: unknown): string | null =>
  e instanceof ApiError && e.body?.code === 'conflict' && e.body.constraint?.includes('prefix') ? 'Another project uses this prefix.' : null

// Live events keep the cache current, so a revisit shows cached data at once
// and refetches behind it. Skeletons depend on `isPending` only, which stays
// false for a query with data, so a background refetch never shows loading.
const STALE_MS = 30_000
const CACHE_MS = 30 * 60_000
const RETRIES = 2

export function createQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: STALE_MS,
        gcTime: CACHE_MS,
        // `api` decides where a request goes: the prototype has fixtures and
        // no network, and must not pause as if it were offline
        networkMode: 'always',
        refetchOnReconnect: false,
        // Events keep the cache current. The stream is what can go wrong on
        // return, so the stream checks that instead of refetching everything.
        refetchOnWindowFocus: false,
        // Data is always replaced whole, so tracking inside it does nothing
        shallow: true,
        // A 4xx is an answer; repeating it won't change it
        retry: (failures, error) => failures < RETRIES && !(error instanceof ApiError && error.status < 500)
      },
      mutations: { networkMode: 'always', shallow: true }
    }
  })
}
