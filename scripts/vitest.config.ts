import { defineConfig } from 'vitest/config'
import { checkCpus } from './check-cpus.ts'

export default defineConfig({ test: { maxWorkers: checkCpus() } })
