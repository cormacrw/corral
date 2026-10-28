import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Starts a throwaway Postgres unless CORRAL_DATABASE_URL is set (D14)
    globalSetup: [fileURLToPath(import.meta.resolve('@corral/db/test-setup'))]
  }
})
