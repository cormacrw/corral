import { QueryClient } from '@tanstack/vue-query'
import { ApiError } from '~/composables/useApi'

// Pages tell failures apart with this; the client itself stays in app/queries
export { ApiError }

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
        // return, so useLive checks that instead of refetching everything.
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
