// Dollars per million tokens. Fresh input has no agreed weight, so the weighted
// cost leaves it out and it's always shown beside the cost.
const CACHE_COST_WEIGHTS = { cacheRead: 0.2, cacheWrite: 8, output: 20 } as const

interface RunUsage {
  agentRuntime: string
  cacheWriteTokens?: number | null
  cacheReadTokens: number | null
  outputTokens: number | null
}

// Codex has no cache writes to report. A Claude run without them is from
// before they were stored, and has them inside its input tokens.
export function cacheWritesUnknown(run: Pick<RunUsage, 'agentRuntime' | 'cacheWriteTokens'>): boolean {
  return (run.cacheWriteTokens === null || run.cacheWriteTokens === undefined) && run.agentRuntime !== 'codex'
}

// Null when cache writes are unknown: without them, runs don't compare
export function weightedRunCost(run: RunUsage): number | null {
  if (cacheWritesUnknown(run)) return null
  return ((run.cacheWriteTokens ?? 0) * CACHE_COST_WEIGHTS.cacheWrite
    + (run.cacheReadTokens ?? 0) * CACHE_COST_WEIGHTS.cacheRead
    + (run.outputTokens ?? 0) * CACHE_COST_WEIGHTS.output) / 1_000_000
}
