import type { Task, InboxItem } from '@corral/contracts'
import { inboxActionApplies, RESOLVE_TARGETS, type InboxAction, type TaskStatus } from '@corral/core'
import { STATUS } from '~/utils/labels'

// Where a failed item's Retry can put the task, the furthest along first
export const RETRY_TARGETS = RESOLVE_TARGETS.toReversed().map(value => ({ label: STATUS[value].label, value }))

interface OfferedAction { value: InboxAction, label: string, icon: string }

// The task's state behind each Inbox item type
const ITEM_TASK: Partial<Record<InboxItem['type'], { status: TaskStatus, stopped: boolean }>> = {
  human_review: { status: 'human_review', stopped: false },
  question: { status: 'blocked', stopped: false },
  blocked: { status: 'blocked', stopped: false },
  failed: { status: 'failed', stopped: false },
  stopped: { status: 'in_progress', stopped: true }
}

// The actions an Inbox item offers, those core says apply to its task
export function inboxActions(type: InboxItem['type'], task: Pick<Task, 'type'> | null, taskLoad: 'loading' | 'failed' | null = null): OfferedAction[] {
  const state = ITEM_TASK[type]
  return state ? offered(type, task, taskLoad).filter(a => inboxActionApplies(a.value, state)) : []
}

// A design's approve goes to version approval, which also starts the build Plan.
// Without a task, approve stays disabled by the page and names what it waits for.
function offered(type: InboxItem['type'], task: Pick<Task, 'type'> | null, taskLoad: 'loading' | 'failed' | null): OfferedAction[] {
  switch (type) {
    case 'human_review': {
      if (!task && !taskLoad) return []
      const approve = taskLoad === 'loading' ? 'Loading task…' : taskLoad === 'failed' ? 'Task not loaded' : task?.type === 'spike' ? 'Accept findings' : task?.type === 'design' ? 'Approve design' : 'Approve and merge'
      return [{ value: 'approve', label: approve, icon: 'i-hugeicons-tick-02' }, { value: 'request_changes', label: 'Request changes', icon: 'i-hugeicons-pencil-edit-02' }]
    }
    case 'question':
    case 'blocked': return [{ value: 'clarify', label: 'Answer', icon: 'i-hugeicons-message-multiple-01' }, { value: 'send_back', label: 'Send back to Backlog', icon: 'i-hugeicons-arrow-turn-backward' }, { value: 'delete', label: 'Delete task', icon: 'i-hugeicons-delete-02' }]
    case 'failed': return [{ value: 'resolve', label: 'Retry', icon: 'i-hugeicons-undo-02' }, { value: 'send_back', label: 'Send back to Backlog', icon: 'i-hugeicons-arrow-turn-backward' }, { value: 'delete', label: 'Delete task', icon: 'i-hugeicons-delete-02' }]
    case 'stopped': return [{ value: 'retry', label: 'Retry', icon: 'i-hugeicons-undo-02' }, { value: 'clarify', label: 'Give direction', icon: 'i-hugeicons-message-multiple-01' }, { value: 'send_back', label: 'Send back to Backlog', icon: 'i-hugeicons-arrow-turn-backward' }, { value: 'delete', label: 'Delete task', icon: 'i-hugeicons-delete-02' }]
    default: return []
  }
}
