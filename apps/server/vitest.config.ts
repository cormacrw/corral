import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Each worker opens a PGlite WASM instance (hundreds of MB). Keep database
    // files parallel without exhausting the runner while other packages test.
    maxWorkers: 2,
    // Opening and migrating a PGlite database is slow when every package's
    // tests run at once
    hookTimeout: 30_000
  }
})
