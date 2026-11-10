import type { TaskStatus } from './status.ts'
import { TRANSITION_RULES } from './task-machine.ts'

export const INBOX_ACTIONS = ['clarify', 'send_back', 'resolve', 'retry', 'approve', 'request_changes', 'delete'] as const
export type InboxAction = typeof INBOX_ACTIONS[number]

// Which statuses each Inbox action applies to: only what's waiting on the
// human can be decided from the Inbox (design/inbox.md, D10)
const INBOX_ACTION_STATUSES: Readonly<Record<InboxAction, readonly TaskStatus[]>> = {
  approve: ['human_review'],
  request_changes: ['human_review'],
  clarify: ['blocked'],
  resolve: ['blocked', 'failed'],
  send_back: ['blocked', 'failed'],
  retry: [],
  delete: ['human_review', 'blocked', 'failed']
}

// A task stopped from repeating (COR-436) waits in the Inbox in its working
// status, where these release the stop
const STOPPED_TASK_ACTIONS: readonly InboxAction[] = ['retry', 'clarify', 'resolve', 'send_back', 'delete']
export const STOPPED_TASK_STATUSES: readonly TaskStatus[] = TRANSITION_RULES.release_stop.from

// The statuses a task waits on the human in, so the Inbox lists it
export const INBOX_TASK_STATUSES: readonly TaskStatus[] = [...new Set(Object.values(INBOX_ACTION_STATUSES).flat())]

export function inboxActionApplies(action: InboxAction, task: { status: TaskStatus, stopped: boolean }): boolean {
  return INBOX_ACTION_STATUSES[action].includes(task.status) || (task.stopped && STOPPED_TASK_ACTIONS.includes(action))
}
