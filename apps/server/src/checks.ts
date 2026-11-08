import type { PullRequestStatus } from '@corral/contracts'
import type { CheckResult } from './github.ts'

// GitHub branch protection accepts all three for a required check
function checkPassed(check: CheckResult): boolean {
  return check.conclusion === 'success' || check.conclusion === 'neutral' || check.conclusion === 'skipped'
}

export function requiredChecks(required: readonly string[], checks: readonly CheckResult[]) {
  const reported = required.map(name => checks.find(c => c.name === name))
  return {
    failed: reported.filter((c): c is CheckResult => c?.conclusion === 'failure'),
    passed: reported.filter((c): c is CheckResult => c !== undefined && checkPassed(c)),
    pending: required.filter(name => !checks.some(c => c.name === name && checkPassed(c)))
  }
}

// Each required check as `results` has them, for showing on any commit
export function checkRows(required: readonly string[], results: readonly CheckResult[]): PullRequestStatus['ci']['checks'] {
  return required.map((name) => {
    const check = results.find(c => c.name === name)
    return { name, conclusion: check?.conclusion ?? 'missing' as const, url: check?.url ?? null }
  })
}

export const failedCheckLine = (check: { name: string, url: string | null }): string => `${check.name}: failed${check.url ? ` (${check.url})` : ''}`
