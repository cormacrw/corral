import type { PlanMessage } from '@corral/contracts'

// One-tap answers to PM questions (design/plan.md)

export const STOP_ASKING = 'Stop asking questions and propose the plan now.'

// The Grill me button: on its own, or about what's in the composer
export function grillMessage(draft: string): string {
  const text = draft.trim()
  return text ? `Grill me on this: ${text}` : 'Grill me'
}

// The question you can still answer: the PM's latest, if you haven't
// written since. Older questions are past, answered or not.
export function openQuestionId(messages: PlanMessage[]): string | null {
  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i]!
    if (m.role === 'human') return null
    if (m.kind === 'question') return m.id
  }
  return null
}

// What you answered a question with: your next message after it
export function answerTo(messages: PlanMessage[], questionId: string): string | null {
  const i = messages.findIndex(m => m.id === questionId)
  if (i < 0) return null
  return messages.slice(i + 1).find(m => m.role === 'human')?.text ?? null
}
