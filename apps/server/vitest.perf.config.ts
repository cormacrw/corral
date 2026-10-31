import { defineConfig } from 'vitest/config'

// `pnpm --filter @corral/server perf`: API timings on a seeded database. Kept
// out of `pnpm test` because it measures rather than checks. See src/api.perf.ts.
export default defineConfig({
  test: {
    include: ['src/**/*.perf.ts'],
    hookTimeout: 300_000,
    testTimeout: 600_000,
    maxWorkers: 1
  }
})
