import { describe, expect, it } from 'vitest'
import { feedbackFixTitle, feedbackPoints, feedbackSimilarity, feedbackTokens, isRepeatedFeedback, REPEATED_FEEDBACK_THRESHOLD, reviewFeedbackText } from './review-feedback.ts'

describe('feedbackTokens', () => {
  it('ignores case, punctuation, accents and repeats', () => {
    expect([...feedbackTokens('The error: “Café” — the ERROR!')]).toEqual(['the', 'error', 'cafe'])
  })
})

describe('feedbackSimilarity', () => {
  it('is 1 for the same feedback, however it is formatted', () => {
    expect(feedbackSimilarity('The error message is missing.', 'the ERROR message is missing')).toBe(1)
  })

  it('is 0 when nothing is shared or a side is empty', () => {
    expect(feedbackSimilarity('Add a loading spinner', 'Fix the date format')).toBe(0)
    expect(feedbackSimilarity('', 'Fix the date format')).toBe(0)
    expect(feedbackSimilarity('', '')).toBe(0)
  })

  it('is symmetric', () => {
    const a = 'The test for the empty state is missing'
    const b = 'Add a test for the empty state'
    expect(feedbackSimilarity(a, b)).toBe(feedbackSimilarity(b, a))
  })

  it('is exactly the threshold when four of five distinct words are shared', () => {
    // {error, message, is, missing} ∩ {error, message, is, still, missing} = 4 of 5
    const score = feedbackSimilarity('Error message is missing', 'Error message is still missing')
    expect(score).toBe(REPEATED_FEEDBACK_THRESHOLD)
    expect(isRepeatedFeedback(score)).toBe(true)
  })

  it('is above the threshold for near-identical feedback', () => {
    const score = feedbackSimilarity(
      'The error message is missing when the form is submitted empty. No message shown',
      'The error message is still missing when the form is submitted empty. No message shown'
    )
    expect(score).toBeGreaterThan(REPEATED_FEEDBACK_THRESHOLD)
    expect(isRepeatedFeedback(score)).toBe(true)
  })

  it('is below the threshold when one word in four differs', () => {
    // 3 shared of 5 distinct
    const score = feedbackSimilarity('Error message is missing', 'Error message is wrong')
    expect(score).toBeCloseTo(0.6)
    expect(score).toBeLessThan(REPEATED_FEEDBACK_THRESHOLD)
    expect(isRepeatedFeedback(score)).toBe(false)
  })

  it('is well below the threshold for clearly different feedback', () => {
    const score = feedbackSimilarity(
      'The error message is missing when the form is submitted empty',
      'Tests now pass, but the README still describes the old command'
    )
    expect(isRepeatedFeedback(score)).toBe(false)
  })
})

describe('reviewFeedbackText', () => {
  it('keeps the summary and the notes on unmet criteria only', () => {
    expect(reviewFeedbackText(' Still wrong ', [
      { met: false, note: 'No message shown' },
      { met: true, note: 'Looks fine' },
      { met: false, note: '' }
    ])).toBe('Still wrong\nNo message shown')
  })
})

describe('feedbackPoints', () => {
  it('takes the list items, joining wrapped lines and leaving out any intro', () => {
    expect(feedbackPoints('Two things:\n\n- Ask before deleting\n  a saved search\n* Keep the toast\n1. Fix the count\n2) Update the docs')).toEqual([
      'Ask before deleting a saved search', 'Keep the toast', 'Fix the count', 'Update the docs'
    ])
  })

  it('takes paragraphs when there is no list', () => {
    expect(feedbackPoints('The toast is wrong.\nIt says saved.\n\nThe count is off.')).toEqual(['The toast is wrong. It says saved.', 'The count is off.'])
  })

  it('skips headings and code blocks', () => {
    expect(feedbackPoints('## Problems\n\n```\n- not a point\n```\n\nThe count is off')).toEqual(['The count is off'])
  })

  it('falls back to the whole feedback when no point is left', () => {
    expect(feedbackPoints('## Problems')).toEqual(['## Problems'])
  })
})

describe('feedbackFixTitle', () => {
  it('uses the first sentence of the first point', () => {
    expect(feedbackFixTitle('- Deleting does not ask for confirmation. It should.\n- Keep the toast')).toBe('Fix integration: Deleting does not ask for confirmation')
  })

  it('shortens a long point', () => {
    const title = feedbackFixTitle('word '.repeat(60))
    expect(title.length).toBeLessThanOrEqual('Fix integration: '.length + 100)
    expect(title.endsWith('…')).toBe(true)
  })
})
