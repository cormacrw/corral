import { describe, expect, it } from 'vitest'
import { isTaskDone, isTaskImmutable, isUnfinishedBoardTask } from './completion.ts'
import { deletionFor } from './deletion.ts'
import { checkEpicDependencies } from './epic-dependencies.ts'
import { TASK_STATUSES } from './status.ts'
import { TASK_TYPES } from './task.ts'
import { transition, type TaskState } from './task-machine.ts'

const human = { kind: 'human', userId: 'u1' } as const
const server = { kind: 'system', component: 'server' } as const
const scheduler = { kind: 'system', component: 'scheduler' } as const
const design: TaskState = { type: 'design', status: 'human_review', humanReview: false, reviewRounds: 0, failedRuns: 0, reason: null }

describe('type-aware completion (D19/D20)', () => {
  it('has exactly one done status per type, with Approved designs remaining deletable', () => {
    for (const type of TASK_TYPES) {
      for (const status of TASK_STATUSES) {
        const task = { type, status }
        expect(isTaskDone(task)).toBe(status === (type === 'design' ? 'approved' : 'merged'))
        expect(isTaskImmutable(task)).toBe(type !== 'design' && status === 'merged')
        expect(isUnfinishedBoardTask(task)).toBe(!['draft', 'backlog'].includes(status) && !isTaskDone(task))
      }
    }
    expect(deletionFor({ type: 'design', status: 'approved' })).toBe('soft')
  })

  it('approves only at the human step, then reopens with required feedback', () => {
    expect(transition({ ...design, status: 'agent_review' }, { type: 'review_approved' }, server))
      .toMatchObject({ ok: true, task: { status: 'human_review' } })
    expect(transition(design, { type: 'human_approve' }, human))
      .toMatchObject({ ok: true, task: { status: 'approved' } })
    expect(transition(design, { type: 'human_approve' }, server).ok).toBe(false)
    expect(transition({ ...design, status: 'approved' }, { type: 'human_request_changes' }, human).ok).toBe(false)
    expect(transition({ ...design, status: 'approved' }, { type: 'human_request_changes', feedback: 'Add a mobile layout' }, human))
      .toMatchObject({ ok: true, task: { status: 'in_progress' } })
    expect(transition(design, { type: 'merged_outside' }, server).ok).toBe(false)
  })

  it('requires Approved for design dependencies and Merged for every other type', () => {
    for (const type of TASK_TYPES) {
      for (const status of TASK_STATUSES) {
        expect(transition({ ...design, type: 'task', status: 'ready' }, { type: 'claim', dependencies: [{ type, status }] }, scheduler).ok)
          .toBe(isTaskDone({ type, status }))
      }
    }
  })

  it('removes Approved designs and Merged work from epic completion waits', () => {
    const graph = new Map([['a', []], ['b', ['a']]])
    const tasks = [
      { id: 'design', epicId: 'a', type: 'design' as const, status: 'approved' as const, dependsOn: ['build'] },
      { id: 'normal', epicId: 'a', type: 'task' as const, status: 'merged' as const, dependsOn: [] },
      { id: 'build', epicId: 'b', type: 'task' as const, status: 'ready' as const, dependsOn: [] }
    ]
    expect(checkEpicDependencies(graph, tasks)).toEqual([])
    expect(checkEpicDependencies(graph, [{ ...tasks[0]!, status: 'human_review' }, ...tasks.slice(1)]))
      .toContainEqual(expect.objectContaining({ code: 'epic_task_deadlock' }))
  })

  it('finishes spikes at Merged while normal approval still waits for merging', () => {
    expect(transition({ ...design, type: 'spike' }, { type: 'human_approve' }, human))
      .toMatchObject({ ok: true, task: { status: 'merged' } })
    expect(transition({ ...design, type: 'task' }, { type: 'human_approve' }, human))
      .toMatchObject({ ok: true, task: { status: 'ready_to_merge' } })
  })
})
