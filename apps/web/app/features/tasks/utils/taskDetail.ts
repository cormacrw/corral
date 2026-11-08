import type { Run, Task } from '@corral/contracts'
import type { TaskStatus } from '@corral/core'
import { canGainSubtasks, RESOLVE_TARGETS } from '@corral/core'
import { boardMove } from '~/features/board/utils/board'
import { STATUS } from '~/utils/labels'

export interface StatusOption { label: string, value: string, status: TaskStatus }

// Status: only the moves a human may make under D10, the same ones as dragging
// on the Board. A human only moves a task to the statuses resolve can reach.
// An option's value is the status it moves to.
export function statusOptions(task: Task): StatusOption[] {
  const options: StatusOption[] = [{ label: STATUS[task.status].label, value: 'current', status: task.status }]
  for (const status of RESOLVE_TARGETS) {
    const move = boardMove(task, status)
    if (move) options.push({ label: move.type === 'human_request_changes' ? `${STATUS[status].label} (request changes)` : STATUS[status].label, value: status, status })
  }
  return options
}

// Unstarted work can gain sub-tasks; the server has the last word (D31)
export function canAddSubtask(task: Task, runs: Run[]): boolean {
  return canGainSubtasks({ ...task, leased: Boolean(task.lease) }) && !task.pr && !task.design && runs.length === 0
}

export const agentHolds = (task: Pick<Task, 'status'>) => ['in_progress', 'blocked', 'agent_review', 'human_review'].includes(task.status)

// Following a link or selecting text to copy shouldn't open an editor
export function wantsEdit(event: MouseEvent) {
  return !(event.target as HTMLElement).closest('a, button') && !window.getSelection()?.toString()
}
