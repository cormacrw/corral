import type { RunEvent, RunPhase, RunTimings } from '@corral/contracts'

// Times one run for run.ended. The run is always in exactly one phase, so the
// phases add up to the total. A phase entered during another pauses it: a
// push inside report_outcome comes out of the agent's time. Time outside any
// named phase counts as `other`.
//
// Tool calls are paired from the neutral RunEvents, so every runtime is timed
// the same way. A call with no result by the end of the run ran until then.

export class RunTimer {
  #now: () => number
  #startedAt: number
  #mark: number
  #active: RunPhase[] = ['other']
  #phases = new Map<RunPhase, number>([['other', 0]])
  #openCalls = new Map<string, { tool: string, startedAt: number }>()
  #tools = new Map<string, { count: number, totalMs: number, maxMs: number }>()

  constructor(now: () => number = () => performance.now()) {
    this.#now = now
    this.#startedAt = now()
    this.#mark = this.#startedAt
  }

  async during<T>(phase: RunPhase, work: () => Promise<T>): Promise<T> {
    this.#accrue()
    this.#active.push(phase)
    try {
      return await work()
    } finally {
      this.#accrue()
      // Tool calls overlap, so this isn't always the innermost phase
      this.#active.splice(this.#active.lastIndexOf(phase), 1)
    }
  }

  observe(events: RunEvent[]): void {
    for (const event of events) {
      // Both parsers fall back to an empty id, which can't be paired
      if (event.type === 'tool_call' && event.id && !this.#openCalls.has(event.id)) {
        this.#openCalls.set(event.id, { tool: event.tool, startedAt: this.#now() })
      } else if (event.type === 'tool_result') {
        const call = this.#openCalls.get(event.id)
        if (!call) continue
        this.#openCalls.delete(event.id)
        this.#record(call.tool, this.#now() - call.startedAt)
      }
    }
  }

  finish(): RunTimings {
    this.#accrue()
    const end = this.#now()
    for (const call of this.#openCalls.values()) this.#record(call.tool, end - call.startedAt)
    this.#openCalls.clear()
    return {
      totalMs: Math.round(end - this.#startedAt),
      phases: [...this.#phases].map(([phase, ms]) => ({ phase, durationMs: Math.round(ms) })),
      tools: [...this.#tools]
        .map(([tool, t]) => ({ tool, count: t.count, totalMs: Math.round(t.totalMs), maxMs: Math.round(t.maxMs) }))
        .sort((a, b) => b.totalMs - a.totalMs)
    }
  }

  #accrue(): void {
    const now = this.#now()
    const phase = this.#active.at(-1)!
    this.#phases.set(phase, (this.#phases.get(phase) ?? 0) + now - this.#mark)
    this.#mark = now
  }

  #record(tool: string, ms: number): void {
    const summary = this.#tools.get(tool) ?? { count: 0, totalMs: 0, maxMs: 0 }
    summary.count += 1
    summary.totalMs += ms
    summary.maxMs = Math.max(summary.maxMs, ms)
    this.#tools.set(tool, summary)
  }
}
