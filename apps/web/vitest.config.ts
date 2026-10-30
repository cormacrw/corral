import { checkCpus } from '../../scripts/check-cpus.ts'
import { fileURLToPath } from 'node:url'
import vue from '@vitejs/plugin-vue'
import { defineConfig } from 'vitest/config'

// Nuxt's `~` alias, so tests can import app code that uses it. Component
// tests compile .vue files and opt into a DOM with @vitest-environment.
export default defineConfig({
  test: { maxWorkers: checkCpus() },
  plugins: [vue()],
  resolve: {
    alias: { '~': fileURLToPath(new URL('./app', import.meta.url)) }
  }
})
