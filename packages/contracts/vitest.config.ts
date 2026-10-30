import { defineConfig } from 'vitest/config'
import { checkCpus } from '../../scripts/check-cpus.ts'

export default defineConfig({ test: { maxWorkers: checkCpus() } })
