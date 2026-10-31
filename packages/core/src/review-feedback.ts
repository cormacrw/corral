// Spotting a reviewer that asks for the same changes twice in a row, so the
// task goes to a human instead of round-tripping until the review-round cap.
// A plain token comparison: cheap, deterministic and no model call.

// Two consecutive change requests at or above this similarity count as the
// same feedback
export const REPEATED_FEEDBACK_THRESHOLD = 0.8

export const REPEATED_FEEDBACK_REASON = 'The reviewer asked for the same changes twice'

// Lowercased words and numbers, without punctuation or accents
export function feedbackTokens(text: string): Set<string> {
  const words = text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []
  return new Set(words)
}

// Jaccard similarity of the two texts' token sets, from 0 (nothing shared)
// to 1 (the same words). Two empty texts are not alike: there's no feedback
// to compare.
export function feedbackSimilarity(a: string, b: string): number {
  const left = feedbackTokens(a)
  const right = feedbackTokens(b)
  if (left.size === 0 || right.size === 0) return 0
  let shared = 0
  for (const token of left) if (right.has(token)) shared++
  return shared / (left.size + right.size - shared)
}

export function isRepeatedFeedback(similarity: number, threshold = REPEATED_FEEDBACK_THRESHOLD): boolean {
  return similarity >= threshold
}

// The part of a changes-requested review that is the reviewer's own words:
// the summary and the notes on unmet criteria. Criterion texts are left out;
// they repeat every round whatever the feedback says.
export function reviewFeedbackText(summary: string, criteria: readonly { met: boolean | null, note: string }[]): string {
  return [summary, ...criteria.filter(c => c.met === false).map(c => c.note)].map(s => s.trim()).filter(Boolean).join('\n')
}

const LIST_ITEM = /^\s*(?:[-*+]|\d+[.)])\s+(.*)$/
const FIX_TITLE_LENGTH = 100

// The separate points of written feedback: its list items, or its paragraphs
// when it has no list. Code blocks and headings stay in the description only.
export function feedbackPoints(feedback: string): string[] {
  const items: string[][] = []
  const paragraphs: string[][] = []
  let item: string[] | null = null
  let paragraph: string[] | null = null
  let fenced = false
  for (const raw of feedback.split('\n')) {
    const line = raw.trim()
    if (line.startsWith('```')) {
      fenced = !fenced
      continue
    }
    if (fenced) continue
    if (!line) {
      item = paragraph = null
      continue
    }
    if (/^#{1,6}\s/.test(line)) continue
    const listed = LIST_ITEM.exec(raw)
    if (listed) {
      item = [listed[1]!]
      paragraph = null
      items.push(item)
    } else if (item) {
      item.push(line)
    } else {
      if (!paragraph) paragraphs.push(paragraph = [])
      paragraph.push(line)
    }
  }
  const points = (items.length > 0 ? items : paragraphs).map(lines => lines.join(' ').trim()).filter(Boolean)
  return points.length > 0 ? points : [feedback.trim()]
}

export const FIX_TITLE_PREFIX = 'Fix integration: '

// A fix task's title: the first sentence of the feedback's first point
export function feedbackFixTitle(feedback: string): string {
  const [sentence = ''] = feedbackPoints(feedback)[0]!.split(/(?<=[.!?])\s/)
  const title = sentence.replace(/[.!;:,]+$/, '')
  return `${FIX_TITLE_PREFIX}${title.length > FIX_TITLE_LENGTH ? `${title.slice(0, FIX_TITLE_LENGTH - 1).trimEnd()}…` : title}`
}

// "1 criterion met; 2 criteria need a human check", for a verdict with human checks
export function humanCheckTally(met: number, humanChecks: number): string {
  return `${met} ${met === 1 ? 'criterion' : 'criteria'} met; ${humanChecks} ${humanChecks === 1 ? 'criterion needs' : 'criteria need'} a human check`
}
