import type { ServerEvent } from '@corral/contracts'

type Listener = (event: ServerEvent) => void

// In-process fan-out from services to SSE streams. The server is a single
// instance (D7), so nothing more is needed.
export class EventBus {
  #listeners = new Set<Listener>()

  publish(event: ServerEvent): void {
    for (const listener of this.#listeners) listener(event)
  }

  // Returns the unsubscribe function
  subscribe(listener: Listener): () => void {
    this.#listeners.add(listener)
    return () => this.#listeners.delete(listener)
  }
}
