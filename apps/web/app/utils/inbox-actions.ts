import type { Task, InboxItem } from '@corral/contracts'

// A design's approve goes to version approval, which also starts the build Plan.
// Without a task, approve stays disabled by the page and names what it waits for.
export function inboxActions(type: InboxItem['type'], task: Pick<Task, 'type'> | null, taskLoad: 'loading' | 'failed' | null = null) {
  switch (type) {
    case 'human_review': {
      if (!task && !taskLoad) return []
      const approve = taskLoad === 'loading' ? 'Loading task…' : taskLoad === 'failed' ? 'Task not loaded' : task?.type === 'spike' ? 'Accept findings' : task?.type === 'design' ? 'Approve design' : 'Approve and merge'
      return [{ value: 'approve', label: approve, icon: 'i-lucide-check' }, { value: 'request_changes', label: 'Request changes', icon: 'i-lucide-pencil' }]
    }
    case 'question':
    case 'blocked': return [{ value: 'clarify', label: 'Clarify and continue', icon: 'i-lucide-message-circle' }, { value: 'send_back', label: 'Send back to Backlog', icon: 'i-lucide-undo-2' }, { value: 'delete', label: 'Delete task', icon: 'i-lucide-trash-2' }]
    case 'failed': return [{ value: 'resolve', label: 'Retry', icon: 'i-lucide-rotate-ccw' }, { value: 'send_back', label: 'Send back to Backlog', icon: 'i-lucide-undo-2' }, { value: 'delete', label: 'Delete task', icon: 'i-lucide-trash-2' }]
    default: return []
  }
}
