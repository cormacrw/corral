import type { EpicFixCheck } from '@corral/core'
import type { GitHubClient } from './github.ts'

// What a fix round is told about each failed check (D8, D29). Developers never
// run `gh`, so the server reads this for them through the runner's.
export interface CiFailure extends EpicFixCheck {
  step: string | null
  // Null when it couldn't be read: the round starts anyway, with the link
  excerpt: string | null
}

// Enough for a stack trace and the assertion above it, in a prompt
export const MAX_EXCERPT_CHARS = 8000
// Kept of the end of a log when failure lines from earlier in it take the rest
const MIN_TAIL_CHARS = 2000
// How much of a raw log leaves the runner, which is where the end can be found
export const MAX_LOG_CHARS = 256_000
// Fixes in a row that CI still failed before it needs a human, on a task or an epic
export const MAX_CI_FIXES = 3
// Each failure costs a few GitHub calls, and the first is usually the cause
const MAX_CHECKS = 3

// eslint-disable-next-line no-control-regex -- terminal colours are what this removes
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g

function endOf(text: string, chars: number): string {
  if (text.length <= chars) return text
  const tail = text.slice(-chars)
  return `… (${text.length - tail.length} earlier characters cut)\n${tail.slice(tail.indexOf('\n') + 1)}`
}

// The end of a log, ending at its last error: after that come the post-job
// steps, which can run long enough to push the failing lines out of the tail.
// Turbo prints a failed package's output long before that, so the failure lines
// the runner found anywhere in the log go first, unless the end has them too.
export function ciExcerpt(log: string, failureLines: readonly string[] = []): string {
  const clean = log.replace(ANSI, '').trimEnd()
  const error = clean.lastIndexOf('##[error]')
  const lineEnd = error === -1 ? -1 : clean.indexOf('\n', error)
  const failing = lineEnd === -1 ? clean : clean.slice(0, lineEnd)
  const tail = endOf(failing, MIN_TAIL_CHARS)
  const earlier = failureLines.filter(line => !tail.includes(line))
  if (earlier.length === 0) return endOf(failing, MAX_EXCERPT_CHARS)
  const heading = 'Failure lines from the whole log:'
  const footing = '\n\nThe end of the log:\n'
  const room = MAX_EXCERPT_CHARS - tail.length - heading.length - footing.length - 1
  return `${heading}\n${earlier.join('\n').slice(0, room)}${footing}${tail}`
}

// Never throws: output that can't be read says so in the prompt
export async function readCiFailures(github: GitHubClient, repository: string, checks: readonly EpicFixCheck[]): Promise<CiFailure[]> {
  return Promise.all(checks.slice(0, MAX_CHECKS).map(async (check) => {
    const read = await github.ciFailure(repository, check).catch((error) => {
      console.warn(`Could not read the CI output of ${check.name}`, error)
      return null
    })
    return { ...check, step: read?.step ?? null, excerpt: read?.log ? ciExcerpt(read.log, read.failureLines) : null }
  }))
}
