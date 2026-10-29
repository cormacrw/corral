import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Opening and migrating a PGlite database is slow when every package's
    // tests run at once
    hookTimeout: 30_000,
    // Starts a throwaway Postgres unless CORRAL_DATABASE_URL is set (D14)
    globalSetup: ['./src/test-setup.ts']
  }
})
