// Shared by the check command and Vitest, including direct package test runs.
export function checkCpus(value = process.env.CORRAL_CHECK_CPUS): number {
  if (value === undefined) return 2
  if (!/^[1-9]\d*$/.test(value) || !Number.isSafeInteger(Number(value))) {
    throw new Error('CORRAL_CHECK_CPUS must be a positive integer')
  }
  return Number(value)
}
