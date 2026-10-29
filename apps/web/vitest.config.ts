import { fileURLToPath } from 'node:url'
import { defineConfig } from 'vitest/config'

// Nuxt's `~` alias, so tests can import app code that uses it
export default defineConfig({
  resolve: {
    alias: { '~': fileURLToPath(new URL('./app', import.meta.url)) }
  }
})
