import type { QueryClient, QueryKey } from '@tanstack/vue-query'
import { hashKey } from '@tanstack/vue-query'
import { subscribeLive, subscribeReconnect } from '~/composables/useLive'
import { applyEvent, invalidateKeys } from './dependencies'

// Events arrive in bursts. Refetch once a burst goes quiet, and at the latest
// after MAX_WAIT_MS so constant traffic can't hold a refetch back forever.
export const QUIET_MS = 300
export const MAX_WAIT_MS = 2000

export interface InvalidationQueue {
  add: (stale: readonly QueryKey[]) => void
  clear: () => void
}

export function createInvalidationQueue(client: QueryClient): InvalidationQueue {
  const pending = new Map<string, QueryKey>()
  let quiet: ReturnType<typeof setTimeout> | null = null
  let deadline: ReturnType<typeof setTimeout> | null = null

  function clear(): void {
    if (quiet) clearTimeout(quiet)
    if (deadline) clearTimeout(deadline)
    quiet = deadline = null
    pending.clear()
  }

  function flush(): void {
    const stale = [...pending.values()]
    clear()
    void invalidateKeys(client, stale)
  }

  return {
    add: (stale) => {
      if (!stale.length) return
      for (const key of stale) pending.set(hashKey(key), key)
      if (quiet) clearTimeout(quiet)
      quiet = setTimeout(flush, QUIET_MS)
      deadline ??= setTimeout(flush, MAX_WAIT_MS)
    },
    clear
  }
}

// Feeds useLive's stream, real or mock, into the query cache. Returns a stop.
export function connectQueries(client: QueryClient): () => void {
  const queue = createInvalidationQueue(client)
  const stopEvents = subscribeLive(event => queue.add(applyEvent(client, event)))
  // Anything could have been missed while disconnected. Queries with data
  // refetch behind it: isFetching changes, isPending doesn't.
  const stopReconnect = subscribeReconnect(() => {
    queue.clear()
    void client.invalidateQueries()
  })
  return () => {
    stopEvents()
    stopReconnect()
    queue.clear()
  }
}
