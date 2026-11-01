import type { Task } from '@corral/contracts'
import { describe, expect, it } from 'vitest'
import { taskBlockers } from './taskBlockers'

const task = (ref: string, status: Task['status'], type: Task['type'] = 'task') => ({ ref, status, type }) as Task
const epic = { id: 'epic-1', title: 'Release foundation' }
const ready = { status: 'ready' as const, dependsOn: ['TA-1', 'TA-2', 'TA-3'], waitingOnEpics: [epic] }

describe('taskBlockers', () => {
  it('lists only unfinished dependencies and waiting epics', () => {
    const pending = task('TA-1', 'ready_to_merge')
    expect(taskBlockers(ready, [pending, task('TA-2', 'merged'), task('TA-3', 'approved', 'design'), task('TA-4', 'blocked')]))
      .toEqual({ tasks: [pending], unlisted: [], epics: [epic] })
  })

  it('keeps all three blockers and removes each as it completes', () => {
    const tasks = [task('TA-1', 'in_progress'), task('TA-2', 'agent_review'), task('TA-3', 'blocked')]
    expect(taskBlockers(ready, tasks).tasks).toEqual(tasks)
    for (const dependency of tasks) dependency.status = 'merged'
    expect(taskBlockers({ ...ready, waitingOnEpics: [] }, tasks)).toEqual({ tasks: [], unlisted: [], epics: [] })
  })

  it.each(['blocked', 'failed', 'in_progress', 'merged'] as const)('never marks a %s card', (status) => {
    expect(taskBlockers({ ...ready, status }, [task('TA-1', 'ready')])).toEqual({ tasks: [], unlisted: [], epics: [] })
  })

  it('counts a dependency missing from the list, such as a Draft, as waiting', () => {
    const listed = task('TA-1', 'in_progress')
    expect(taskBlockers({ ...ready, waitingOnEpics: [] }, [listed, task('TA-2', 'merged')]))
      .toEqual({ tasks: [listed], unlisted: ['TA-3'], epics: [] })
  })

  it('never marks a card other than Ready for an unlisted dependency', () => {
    expect(taskBlockers({ ...ready, status: 'in_progress' }, []).unlisted).toEqual([])
  })

  it('supports an epic as the only blocker', () => {
    expect(taskBlockers({ ...ready, dependsOn: [] }, [])).toEqual({ tasks: [], unlisted: [], epics: [epic] })
  })
})
