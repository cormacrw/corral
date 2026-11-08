import { ciExcerpt } from '@corral/contracts'
import type { GateCheck } from '@corral/core'
import type { GitHubClient } from './github.ts'

// What a fix round is told about each failed check (D8, D29). Developers never
// run `gh`, so the server reads this for them through the runner's.
export interface CiFailure extends GateCheck {
  step: string | null
  // Null when it couldn't be read: the round starts anyway, with the link
  excerpt: string | null
}

// Each failure costs a few GitHub calls, and the first is usually the cause
const MAX_CHECKS = 3

// Never throws: output that can't be read says so in the prompt
export async function readCiFailures(github: GitHubClient, repository: string, checks: readonly GateCheck[]): Promise<CiFailure[]> {
  return Promise.all(checks.slice(0, MAX_CHECKS).map(async (check) => {
    const read = await github.ciFailure(repository, check).catch((error) => {
      console.warn(`Could not read the CI output of ${check.name}`, error)
      return null
    })
    return { ...check, step: read?.step ?? null, excerpt: read?.log ? ciExcerpt(read.log, read.failureLines) : null }
  }))
}
