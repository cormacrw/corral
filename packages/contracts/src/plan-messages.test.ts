import { describe, expect, it } from 'vitest'
import { planMessageFields, planMessageInput, startPlanSessionInput } from './api.ts'

describe('plan message fields', () => {
  it('accepts each role and kind, with the fields that kind can carry', () => {
    expect(planMessageFields.parse({ role: 'human', kind: 'message', text: 'Hi' })).toEqual({ role: 'human', kind: 'message', text: 'Hi', recommendation: null, options: null })
    expect(planMessageFields.parse({ role: 'pm', kind: 'error', text: 'Failed' })).toMatchObject({ recommendation: null, options: null })
    expect(planMessageFields.parse({ role: 'pm', kind: 'question', text: 'Which?', recommendation: 'A', options: ['A', 'B'] })).toMatchObject({ recommendation: 'A', options: ['A', 'B'] })
  })

  it.each([
    ['a human recommendation', { role: 'human', kind: 'message', text: 'Hi', recommendation: 'A' }],
    ['human options', { role: 'human', kind: 'message', text: 'Hi', options: ['A', 'B'] }],
    ['a human question', { role: 'human', kind: 'question', text: 'Hi' }],
    ['a PM message with options', { role: 'pm', kind: 'message', text: 'Hi', options: ['A', 'B'] }],
    ['a PM error with a recommendation', { role: 'pm', kind: 'error', text: 'Hi', recommendation: 'A' }],
    ['an empty question', { role: 'pm', kind: 'question', text: '' }],
    ['an unknown role', { role: 'system', kind: 'message', text: 'Hi' }],
    ['an unknown kind', { role: 'pm', kind: 'note', text: 'Hi' }]
  ])('rejects %s', (_, fields) => {
    expect(planMessageFields.safeParse(fields).success).toBe(false)
  })
})

describe('human message inputs', () => {
  it.each([{ recommendation: 'A' }, { options: ['A', 'B'] }])('rejects question fields %j', (fields) => {
    expect(planMessageInput.safeParse({ text: 'Hi', ...fields }).success).toBe(false)
    expect(startPlanSessionInput.safeParse({ projectId: crypto.randomUUID(), text: 'Hi', ...fields }).success).toBe(false)
  })

  it('still accepts text and a task ref', () => {
    expect(planMessageInput.parse({ text: 'Hi', taskRef: 'COR-1' })).toEqual({ text: 'Hi', taskRef: 'COR-1' })
  })
})
