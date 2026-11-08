import { MAX_NOTE_LENGTH } from '@corral/contracts'
import type { CriterionVerdict } from '@corral/core'

// A spike's findings, as the comment the Inbox shows for its review (D19)
const FINDINGS_HEADING = '## Findings\n'

export function findingsComment(summary: string): string {
  return `${FINDINGS_HEADING}\n${summary.trim()}`
}

export function isFindingsComment(body: string): boolean {
  return body.startsWith(FINDINGS_HEADING)
}

const NOTE_EXAMPLE = 'Rebased onto 6e67d6f; resolved conflict in docs/architecture.md keeping main’s SSE wording'

// What a work note is, as the prompt and the refusal both say it
export const WORK_NOTE_RULE = `one line of at most ${MAX_NOTE_LENGTH} characters saying what this run did, e.g. "${NOTE_EXAMPLE}"`

// Why a developer's work note is not acceptable, if it isn't
export function noteProblem(note: string | undefined): string | null {
  if (!note) return 'The work note is missing.'
  if (/[\r\n]/.test(note)) return 'The work note must be a single line.'
  if (note.length > MAX_NOTE_LENGTH) return `The work note is ${note.length} characters; the limit is ${MAX_NOTE_LENGTH}.`
  return null
}

// The review as a comment the developer reads next round
export function feedbackComment(summary: string, verdicts: CriterionVerdict[], criteria: { id: string, text: string }[]): string {
  const lines = verdicts.map((v) => {
    const text = criteria.find(c => c.id === v.criterionId)?.text ?? v.criterionId
    return `- ${v.met === null ? 'Needs human check:' : v.met ? '✅' : '❌'} ${text}${v.note ? ` — ${v.note}` : ''}`
  })
  return [summary.trim(), '', ...lines].join('\n').trim()
}
