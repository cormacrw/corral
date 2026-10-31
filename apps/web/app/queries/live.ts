import type { QueryClient, QueryKey } from '@tanstack/vue-query'
import { hashKey } from '@tanstack/vue-query'
import type { ServerEvent } from '@corral/contracts'
import { api } from '~/composables/useApi'
import { subscribeLive, subscribeReconnect } from '~/composables/useLive'
import { applyEvent, invalidateKeys } from './dependencies'

// Events arrive in bursts, with pauses inside them. Refetch after a full second
// without an event, so any gap within a one-second burst keeps it together, and
// at the latest after MAX_WAIT_MS so constant traffic can't hold a refetch back
// forever. MAX_WAIT_MS must exceed QUIET_MS: it's what a burst fits inside.
export const QUIET_MS = 1000
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

interface ConnectOptions {
  // The Plan thread on screen, whose replies are read as they arrive
  openSession?: () => unknown
  // Sees every event, with or without a conversation mounted
  onEvent?: (event: ServerEvent) => void
}

// Feeds useLive's stream, real or mock, into the query cache. Returns a stop.
export function connectQueries(client: QueryClient, { openSession, onEvent }: ConnectOptions = {}): () => void {
  const queue = createInvalidationQueue(client)
  const stopEvents = subscribeLive((event) => {
    onEvent?.(event)
    // Before the cache, so it gets the session as read
    if (event.type === 'plan.session' && event.session.unread && openSession?.() === event.session.id) {
      event.session = { ...event.session, unread: false }
      void api.plan.read(event.session.id).catch(() => {})
    }
    queue.add(applyEvent(client, event))
  })
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
