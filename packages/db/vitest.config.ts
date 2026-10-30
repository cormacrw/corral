import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Opening and migrating a PGlite database is slow when every package's
    // tests run at once
    hookTimeout: 30_000
  }
})
