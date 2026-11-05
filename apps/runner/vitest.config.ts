import { defineConfig } from 'vitest/config'
import { checkCpus } from '../../scripts/check-cpus.ts'

export default defineConfig({
  test: {
    maxWorkers: checkCpus(),
    // Polls wait on child processes and git while other workers compete for
    // CPU, so the 1s default fails under load. Only failing runs take longer
    expect: { poll: { timeout: 5_000 } }
  }
})
