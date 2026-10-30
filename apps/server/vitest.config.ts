import { checkCpus } from '../../scripts/check-cpus.ts'
import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Each worker opens a PGlite WASM instance (hundreds of MB). Keep database
    // files parallel without exhausting the runner while other packages test.
    maxWorkers: checkCpus(),
    // Opening and migrating a PGlite database is slow when every package's
    // tests run at once
    hookTimeout: 30_000,
    // Starts a throwaway Postgres unless CORRAL_DATABASE_URL is set (D14)
    globalSetup: [fileURLToPath(import.meta.resolve('@corral/db/test-setup'))]
  }
})
