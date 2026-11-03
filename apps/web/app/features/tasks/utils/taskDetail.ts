import type { HumanTransitionInput, Run, Task } from '@corral/contracts'
import type { TaskStatus } from '@corral/core'
import { availableEvents } from '@corral/core'
import { ApiError } from '~/queries/client'
import { STATUS } from '~/utils/labels'

export interface StatusOption { label: string, value: string, status: TaskStatus }

// Status: only the moves a human may make under D10
export function statusOptions(task: Task): StatusOption[] {
  const state = { type: task.type, status: task.status, humanReview: task.humanReview, reviewRounds: task.reviewRounds, failedRuns: task.failedRuns, reason: task.statusReason }
  const events = availableEvents(state, { kind: 'human', userId: 'me' })
  const options: StatusOption[] = [{ label: STATUS[task.status].label, value: 'current', status: task.status }]
  if (events.includes('approve')) options.push({ label: 'Ready', value: 'approve', status: 'ready' })
  if (events.includes('send_back')) options.push({ label: 'Backlog', value: 'send_back', status: 'backlog' })
  if (events.includes('human_request_changes') && task.status !== 'approved') options.push({ label: 'In progress (request changes)', value: 'human_request_changes', status: 'in_progress' })
  if (events.includes('resolve')) {
    options.push({ label: 'Backlog', value: 'resolve:backlog', status: 'backlog' }, { label: 'Ready', value: 'resolve:ready', status: 'ready' }, { label: 'In progress', value: 'resolve:in_progress', status: 'in_progress' })
  }
  return options
}

// The transition a status option's value stands for
export function statusMove(value: string): { input: HumanTransitionInput, status: TaskStatus } {
  if (value === 'approve') return { input: { type: value }, status: 'ready' }
  if (value === 'send_back') return { input: { type: value }, status: 'backlog' }
  if (value === 'human_request_changes') return { input: { type: value }, status: 'in_progress' }
  const to = value.slice('resolve:'.length) as 'backlog' | 'ready' | 'in_progress'
  return { input: { type: 'resolve', to }, status: to }
}

// What a task lacks when the server refused to move it, or null for any other error
export function notReadyNeeds(e: unknown): string | null {
  if (!(e instanceof ApiError) || e.body?.code !== 'transition_rejected' || e.body.reason.code !== 'not_ready') return null
  return e.body.reason.problems.map(p => p.replaceAll('_', ' ')).join(', ')
}

// Unstarted work can gain sub-tasks; the server has the last word (D31)
export function canAddSubtask(task: Task, runs: Run[]): boolean {
  return !task.epicId && !task.lease && !task.pr && !task.design && ['draft', 'backlog', 'ready'].includes(task.status) && ['task', 'bug'].includes(task.type) && runs.length === 0
}

export const agentHolds = (task: Pick<Task, 'status'>) => ['in_progress', 'blocked', 'agent_review', 'human_review'].includes(task.status)
export const workerRole = (task: Pick<Task, 'type'>) => task.type === 'design' ? 'designer' : 'developer'

// Following a link or selecting text to copy shouldn't open an editor
export function wantsEdit(event: MouseEvent) {
  return !(event.target as HTMLElement).closest('a, button') && !window.getSelection()?.toString()
}
