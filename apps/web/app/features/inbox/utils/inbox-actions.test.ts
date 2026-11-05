import { expect, it } from 'vitest'
import { inboxActions } from '~/features/inbox/utils/inbox-actions'

it('offers version approval for designs, and nothing generic while task type is loading', () => {
  expect(inboxActions('human_review', { type: 'design' }).map(a => a.label)).toEqual(['Approve design', 'Request changes'])
  expect(inboxActions('human_review', null)).toEqual([])
  expect(inboxActions('human_review', { type: 'task' }).map(a => a.value)).toEqual(['approve', 'request_changes'])
  expect(inboxActions('human_review', { type: 'spike' })[0]?.label).toBe('Accept findings')
  expect(inboxActions('human_review', null, 'loading')[0]?.label).toBe('Loading task…')
  expect(inboxActions('human_review', null, 'failed')[0]?.label).toBe('Task not loaded')
})

it('offers a stopped task a way to retry, redirect or send it back', () => {
  expect(inboxActions('stopped', { type: 'task' }).map(a => a.value)).toEqual(['retry', 'clarify', 'send_back', 'delete'])
})
