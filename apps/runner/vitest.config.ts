import { defineConfig } from 'vitest/config'
import { checkCpus } from '../../scripts/check-cpus.ts'

export default defineConfig({
  test: {
    maxWorkers: checkCpus(),
    // Most runner tests run real git and child processes: a 0.5 s test can take
    // ten times that while other workers compete for CPU, and some polls wait
    // up to 10 s. Only failing or genuinely stuck runs take this long
    testTimeout: 20_000,
    hookTimeout: 20_000,
    // Polls wait on child processes and git while other workers compete for
    // CPU, so the 1s default fails under load. Only failing runs take longer
    expect: { poll: { timeout: 5_000 } }
  }
})
