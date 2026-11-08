import type { Task } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { boardMove } from '~/features/board/utils/board'
import { statusOptions } from '~/features/tasks/utils/taskDetail'

describe('statusOptions', () => {
  const task = (status: Task['status']) => ({ type: 'task', status, humanReview: false, reviewRounds: 0, failedRuns: 0, statusReason: null }) as Task

  it.each([
    ['backlog', { type: 'approve' }, 'ready'],
    ['ready', { type: 'send_back' }, 'backlog'],
    ['human_review', { type: 'human_request_changes' }, 'in_progress'],
    ['failed', { type: 'resolve', to: 'ready' }, 'ready']
  ] as const)('moves a %s task', (from, input, status) => {
    const option = statusOptions(task(from)).find(o => o.value === status)
    expect(option?.status).toBe(status)
    expect(boardMove(task(from), option!.status)).toEqual(input)
  })
})
