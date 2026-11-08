// A CI log's excerpt for a fix round's prompt (D8, D29). The runner reads the
// log and finds its failure lines; the server builds the excerpt from them.

// eslint-disable-next-line no-control-regex -- terminal colours are what this removes
const ANSI = /\u001B\[[0-9;]*[A-Za-z]/g

export const stripAnsi = (text: string) => text.replace(ANSI, '')

// Enough for a stack trace and the assertion above it, in a prompt
export const MAX_EXCERPT_CHARS = 8000
// Kept of the end of a log when failure lines from earlier in it take the rest
const MIN_TAIL_CHARS = 2000

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
  const clean = stripAnsi(log).trimEnd()
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
