import { z } from 'zod'
import { PAGE_PATTERNS, PERF_WINDOWS, type PerfWindow } from './client.ts'

export { PAGE_PATTERNS, PERF_WINDOWS, type PerfWindow } from './client.ts'

export const CLIENT_PERF_MAX_BYTES = 32 * 1024
export const clientPerfInput = z.strictObject({
  sessionId: z.uuid(),
  samples: z.array(z.strictObject({
    name: z.enum(PAGE_PATTERNS),
    metric: z.enum(['navigation', 'ttfb', 'domReady', 'load', 'LCP', 'INP', 'CLS']),
    value: z.number().finite().nonnegative().max(86_400_000)
  })).min(1).max(50)
})
export type ClientPerfSample = z.infer<typeof clientPerfInput>['samples'][number]

export const perfSummaryQuery = z.object({ window: z.enum(PERF_WINDOWS).default('24h') })

export interface PerfRouteSummary {
  name: string
  count: number
  p50Ms: number
  p95Ms: number
  maxMs: number
  // Null when every sample predates query timing
  avgDbTimeMs: number | null
  avgQueries: number | null
}

export interface PerfPageSummary {
  name: string
  count: number
  p50Ms: number
  p95Ms: number
}

// CLS is a unitless score; LCP and INP are milliseconds. Null means no samples.
export interface PerfVitals {
  LCP: number | null
  INP: number | null
  CLS: number | null
}

export interface PerfSummary {
  window: PerfWindow
  slowThresholdMs: number
  routes: PerfRouteSummary[]
  pages: PerfPageSummary[]
  vitals: PerfVitals
}
