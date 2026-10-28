import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    // Starts a throwaway Postgres unless CORRAL_DATABASE_URL is set (D14)
    globalSetup: ['./src/test-setup.ts']
  }
})
