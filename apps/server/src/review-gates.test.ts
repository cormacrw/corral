import { expect, it } from 'vitest'
import { lostHumanChecks, lowersMode, matchCriteria, taskReview } from './review-gates.ts'

const human = { id: 'h', text: 'A person checks it', checkedByHuman: true }
const agent = { id: 'a', text: 'Tests pass', checkedByHuman: false }

it('keeps ids by text and the human flag through a rewording', () => {
  expect(matchCriteria([human, agent], ['Tests pass', { text: 'Someone checks it' }])).toEqual([
    { id: 'a', text: 'Tests pass', checkedByHuman: false },
    { id: 'h', text: 'Someone checks it', checkedByHuman: true }
  ])
})

it('finds a human check that is dropped or cleared', () => {
  expect(lostHumanChecks([human, agent], matchCriteria([human, agent], ['Tests pass']))).toEqual([human])
  expect(lostHumanChecks([human], matchCriteria([human], [{ text: human.text, checkedByHuman: false }]))).toEqual([human])
  expect(lostHumanChecks([human], matchCriteria([human], [{ text: 'Reworded' }]))).toEqual([])
})

it('ranks review by the task\'s own flag first, then its epic', () => {
  const plain = { type: 'task', humanReview: false } as const
  expect(taskReview(plain, 'epic')).toBeGreaterThan(taskReview(plain, 'direct'))
  expect(taskReview(plain, null)).toBe(taskReview(plain, 'direct'))
  expect(taskReview({ type: 'task', humanReview: true }, null)).toBeGreaterThan(taskReview(plain, 'epic'))
  expect(taskReview({ type: 'spike', humanReview: false }, null)).toBe(taskReview({ type: 'task', humanReview: true }, 'direct'))
  // Leaving a retired each_task epic still lowers review
  expect(lowersMode('each_task', 'epic')).toBe(true)
})
