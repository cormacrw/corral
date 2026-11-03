import { describe, expect, it } from 'vitest'
import { statusMove } from '~/features/tasks/utils/taskDetail'

describe('statusMove', () => {
  it.each([
    ['approve', { type: 'approve' }, 'ready'],
    ['send_back', { type: 'send_back' }, 'backlog'],
    ['human_request_changes', { type: 'human_request_changes' }, 'in_progress'],
    ['resolve:ready', { type: 'resolve', to: 'ready' }, 'ready']
  ])('reads %s', (value, input, status) => {
    expect(statusMove(value)).toEqual({ input, status })
  })
})
