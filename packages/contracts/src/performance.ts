import { z } from 'zod'

// Explicit patterns keep identifiers and query strings out of diagnostics.
export const PAGE_PATTERNS = [
  '/', '/home', '/projects', '/setup', '/plan', '/plan/[sessionId]',
  '/projects/[slug]', '/projects/[slug]/board', '/projects/[slug]/backlog',
  '/projects/[slug]/settings', '/projects/[slug]/pull-requests',
  '/tasks/[ref]', '/epics/[id]', '/designs/[versionId]',
  '/inbox/[[itemId]]', '/settings/[[section]]', '/agents/[name]/[[runId]]'
] as const

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
