import type { ServerEvent } from '@corral/contracts'
import { serverEventTypes } from '~/queries/dependencies'

// The app's one connection to the server's SSE stream, and its status
// (design/app-shell.md). Reconnects after drops (D12). Data comes from
// app/queries, which alone listens to the stream: read it with a query.
export type LiveConnection = 'connecting' | 'open' | 'reconnecting'

type Listener = (event: ServerEvent) => void

const listeners = new Set<Listener>()
const reconnectListeners = new Set<() => void>()
let source: EventSource | null = null
let retryTimer: ReturnType<typeof setTimeout> | null = null
let retryMs = 1000

// Every event on the stream, real or mock. For the query layer's plugin.
export function subscribeLive(listener: Listener): () => void {
  listeners.add(listener)
  return () => listeners.delete(listener)
}

// Called when the stream comes back after a drop
export function subscribeReconnect(listener: () => void): () => void {
  reconnectListeners.add(listener)
  return () => reconnectListeners.delete(listener)
}

export function useLive() {
  const connection = useState<LiveConnection>('live-connection', () => 'connecting')

  function apply(event: ServerEvent): void {
    for (const listener of listeners) listener(event)
  }

  function connect(): void {
    if (source || typeof window === 'undefined') return
    // The static prototype has no server to stream from; its mock API sends
    // the events a write would have caused
    if (import.meta.prototype) {
      connection.value = 'open'
      void import('~/prototype/mock-api').then(({ onMockEvent }) => onMockEvent(apply))
      return
    }
    source = new EventSource('/api/events')
    for (const type of serverEventTypes) {
      source.addEventListener(type, (message) => {
        apply(JSON.parse((message as MessageEvent).data) as ServerEvent)
      })
    }
    source.addEventListener('ready', () => {
      const wasReconnecting = connection.value === 'reconnecting'
      connection.value = 'open'
      retryMs = 1000
      // Anything missed while disconnected
      if (wasReconnecting) {
        for (const listener of reconnectListeners) listener()
      }
    })
    source.onerror = () => {
      source?.close()
      source = null
      connection.value = 'reconnecting'
      if (retryTimer) clearTimeout(retryTimer)
      retryTimer = setTimeout(connect, retryMs)
      retryMs = Math.min(retryMs * 2, 15_000)
    }
  }

  return { connection, connect }
}
