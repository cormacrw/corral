// Free of zod: the web app imports it through /client.

// Explicit patterns keep identifiers and query strings out of diagnostics.
// One per page in apps/web/app/pages (a web test checks it covers them all).
export const PAGE_PATTERNS = [
  '/', '/home', '/projects', '/setup', '/plan', '/plan/[sessionId]',
  '/projects/[slug]', '/projects/[slug]/board', '/projects/[slug]/backlog',
  '/projects/[slug]/settings', '/projects/[slug]/pull-requests',
  '/tasks/[ref]', '/epics/[id]', '/designs/[versionId]',
  '/inbox', '/inbox/[itemId]',
  '/settings', '/settings/[section]', '/settings/profile', '/settings/agents',
  '/settings/runner', '/settings/performance', '/settings/appearance',
  '/agents', '/agents/[name]/[[runId]]'
] as const

export const PERF_WINDOWS = ['1h', '24h', '7d'] as const
export type PerfWindow = (typeof PERF_WINDOWS)[number]
