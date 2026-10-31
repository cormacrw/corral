// How many refused merges before giving up (D10: "GitHub merge failed and
// retrying isn't safe"; flows.md §4 step 7). A new head starts again.
export const MAX_MERGE_ATTEMPTS = 3

// Merge attempts per task or epic, counted per head: refusals on one commit
// say nothing about the next
export class HeadAttempts {
  #counts = new Map<string, { headSha: string, attempts: number }>()

  next(id: string, headSha: string): number {
    const held = this.#counts.get(id)
    const attempts = held?.headSha === headSha ? held.attempts + 1 : 1
    this.#counts.set(id, { headSha, attempts })
    return attempts
  }

  clear(id: string): void {
    this.#counts.delete(id)
  }
}

// When to look at something again. Each `later` doubles the wait up to `maxMs`,
// and `clear` starts over. Kept in memory: a restart just looks sooner.
export class Backoff {
  #first: number
  #max: number
  #now: () => number
  #waits = new Map<string, { until: number, ms: number }>()

  constructor(firstMs: number, maxMs: number, now: () => Date) {
    this.#first = firstMs
    this.#max = maxMs
    this.#now = () => now().getTime()
  }

  due(id: string): boolean {
    const wait = this.#waits.get(id)
    return !wait || this.#now() >= wait.until
  }

  // Everything still waiting
  waiting(): string[] {
    return [...this.#waits.keys()].filter(id => !this.due(id))
  }

  later(id: string): void {
    const previous = this.#waits.get(id)
    const ms = previous ? Math.min(previous.ms * 2, this.#max) : this.#first
    this.#waits.set(id, { until: this.#now() + ms, ms })
  }

  clear(id: string): void {
    this.#waits.delete(id)
  }
}
