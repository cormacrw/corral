import type { Task, InboxItem } from '@corral/contracts'

// Where a failed item's Retry can put the task
export const RESOLVE_TARGETS = [{ label: 'In progress', value: 'in_progress' }, { label: 'Ready', value: 'ready' }, { label: 'Backlog', value: 'backlog' }]

// A design's approve goes to version approval, which also starts the build Plan.
// Without a task, approve stays disabled by the page and names what it waits for.
export function inboxActions(type: InboxItem['type'], task: Pick<Task, 'type'> | null, taskLoad: 'loading' | 'failed' | null = null) {
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
