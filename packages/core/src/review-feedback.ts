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
export function reviewFeedbackText(summary: string, criteria: readonly { met: boolean, note: string }[]): string {
  return [summary, ...criteria.filter(c => !c.met).map(c => c.note)].map(s => s.trim()).filter(Boolean).join('\n')
}
