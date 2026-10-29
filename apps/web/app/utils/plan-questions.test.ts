import type { PlanMessage } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { answerTo, grillMessage, openQuestionId } from './plan-questions.ts'

const msg = (id: string, role: 'pm' | 'human', kind: PlanMessage['kind'] = 'message', text = id): PlanMessage =>
  ({ id, sessionId: 's', role, kind, text, recommendation: null, options: null, planId: null, runId: null, createdAt: '' })

describe('openQuestionId', () => {
  it('is the latest question until you write', () => {
    expect(openQuestionId([msg('h1', 'human'), msg('q1', 'pm', 'question')])).toBe('q1')
    expect(openQuestionId([msg('q1', 'pm', 'question'), msg('q2', 'pm', 'question')])).toBe('q2')
    expect(openQuestionId([msg('q1', 'pm', 'question'), msg('r', 'pm')])).toBe('q1')
    expect(openQuestionId([msg('q1', 'pm', 'question'), msg('h1', 'human')])).toBeNull()
    expect(openQuestionId([msg('h1', 'human'), msg('r', 'pm')])).toBeNull()
  })
})

describe('answerTo', () => {
  it('is your next message after the question', () => {
    const messages = [msg('q1', 'pm', 'question'), msg('r', 'pm'), msg('h1', 'human', 'message', 'SQLite'), msg('h2', 'human')]
    expect(answerTo(messages, 'q1')).toBe('SQLite')
    expect(answerTo(messages, 'h2')).toBeNull()
  })
})

describe('grillMessage', () => {
  it('grills you on the draft if there is one', () => {
    expect(grillMessage('')).toBe('Grill me')
    expect(grillMessage(' A billing page \n')).toBe('Grill me on this: A billing page')
  })
})
