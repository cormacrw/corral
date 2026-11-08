import { expect, it } from 'vitest'
import { inboxActions } from '~/features/inbox/utils/inbox-actions'

it('offers approval named for what the task is, and nothing generic while task type is unknown', () => {
  expect(inboxActions('human_review', null)).toEqual([])
  for (const type of ['task', 'design', 'spike'] as const) expect(inboxActions('human_review', { type }).map(a => a.value)).toEqual(['approve', 'request_changes'])
  const approve = (type: 'task' | 'design' | 'spike') => inboxActions('human_review', { type })[0]!.label
  expect(approve('design')).toMatch(/design/i)
  expect(approve('spike')).toMatch(/findings/i)
  expect(new Set([approve('task'), approve('design'), approve('spike')]).size).toBe(3)
  // Still offered while the task loads or failed to, saying which
  expect(inboxActions('human_review', null, 'loading')[0]?.label).toMatch(/loading/i)
  expect(inboxActions('human_review', null, 'failed')[0]?.label).toMatch(/not loaded/i)
})

it('offers a stopped task a way to retry, redirect or send it back', () => {
  expect(inboxActions('stopped', { type: 'task' }).map(a => a.value)).toEqual(['retry', 'clarify', 'send_back', 'delete'])
})
