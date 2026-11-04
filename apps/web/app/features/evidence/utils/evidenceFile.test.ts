import { expect, it } from 'vitest'
import { evidenceCriterion } from '~/features/evidence/utils/evidenceFile'

const criteria = [{ id: 'c1', text: 'Expired codes show why' }, { id: 'c2', text: 'Checkout still works' }]

it('names the criterion a file proves, or the task as a whole', () => {
  expect(evidenceCriterion({ criterionId: 'c2' }, criteria)).toBe('Checkout still works')
  expect(evidenceCriterion({ criterionId: null }, criteria)).toBe('Task as a whole')
  // A criterion since removed from the task
  expect(evidenceCriterion({ criterionId: 'gone' }, criteria)).toBe('Task as a whole')
})
