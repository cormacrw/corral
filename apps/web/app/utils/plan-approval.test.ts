import type { Plan } from '@corral/contracts'
import { describe, expect, it, vi } from 'vitest'
import { approvedMessage, approvePlan } from './plan-approval.ts'

const item = (key: string, change: Plan['tasks'][number]['change'] = 'added'): Plan['tasks'][number] =>
  ({ key, change, revises: false, taskId: null, epicId: null, ref: null, title: key, status: 'draft', priority: 'medium', humanReview: false, dependsOn: [] })
const plan = (tasks = [item('a'), item('b'), item('c', 'removed')]): Plan =>
  ({ id: 'p1', sessionId: 's1', projectId: 'pr', epicId: null, version: 1, title: 'Plan', summary: '', status: 'proposed', approvedAt: null, epics: [], tasks, createdAt: '' })

function deps(mobile: boolean, approve = vi.fn(async (_id: string, to: 'ready' | 'backlog') => ({ ...plan(), status: 'approved' as const, tasks: plan().tasks.map(t => ({ ...t, status: to })) }))) {
  const calls: string[] = []
  return {
    calls,
    approve,
    toast: { add: vi.fn() },
    mobile,
    closeSheet: vi.fn(async () => void calls.push('close')),
    push: vi.fn(async (path: string) => void calls.push(`push ${path}`))
  }
}

describe('approvedMessage', () => {
  it('counts the tasks added and says where', () => {
    expect(approvedMessage(plan(), 'ready')).toBe('2 tasks added to the board')
    expect(approvedMessage(plan([item('a')]), 'backlog')).toBe('1 task added to the Backlog')
  })
})

describe('approvePlan', () => {
  it.each(['ready', 'backlog'] as const)('on a phone, approving to %s closes the sheet, goes to a new Plan thread and confirms', async (to) => {
    const d = deps(true)
    expect(await approvePlan(plan(), to, d)).toBe(true)
    expect(d.approve).toHaveBeenCalledWith('p1', to)
    expect(d.calls).toEqual(['close', 'push /plan'])
    expect(d.toast.add).toHaveBeenCalledWith({
      title: 'Plan approved',
      description: `2 tasks added to the ${to === 'ready' ? 'board' : 'Backlog'}`,
      color: 'success'
    })
  })

  it('on a phone, a failed approval stays on the session with the sheet open', async () => {
    const d = deps(true, vi.fn(async () => {
      throw new Error('Plan is superseded')
    }))
    expect(await approvePlan(plan(), 'ready', d)).toBe(false)
    expect(d.closeSheet).not.toHaveBeenCalled()
    expect(d.push).not.toHaveBeenCalled()
    expect(d.toast.add).toHaveBeenCalledWith({ title: 'Could not approve', description: 'Plan is superseded', color: 'error' })
  })

  it('on desktop, stays on the session', async () => {
    const d = deps(false)
    expect(await approvePlan(plan(), 'ready', d)).toBe(true)
    expect(d.approve).toHaveBeenCalledWith('p1', 'ready')
    expect(d.closeSheet).not.toHaveBeenCalled()
    expect(d.push).not.toHaveBeenCalled()
    expect(d.toast.add).not.toHaveBeenCalled()
  })
})
