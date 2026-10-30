import type { Task, TaskInboxItemType } from '@corral/contracts'

// Design approval belongs to the version panel, which also starts the build Plan.
export function inboxActions(type: TaskInboxItemType, task: Pick<Task, 'type'> | null) {
  switch (type) {
    case 'human_review': return !task || task.type === 'design' ? [] : [{ value: 'approve', label: 'Approve and merge', icon: 'i-lucide-check' }, { value: 'request_changes', label: 'Request changes', icon: 'i-lucide-pencil' }]
    case 'question':
    case 'blocked': return [{ value: 'clarify', label: 'Clarify and continue', icon: 'i-lucide-message-circle' }, { value: 'send_back', label: 'Send back to Backlog', icon: 'i-lucide-undo-2' }, { value: 'delete', label: 'Delete task', icon: 'i-lucide-trash-2' }]
    case 'failed': return [{ value: 'resolve', label: 'Retry', icon: 'i-lucide-rotate-ccw' }, { value: 'send_back', label: 'Send back to Backlog', icon: 'i-lucide-undo-2' }, { value: 'delete', label: 'Delete task', icon: 'i-lucide-trash-2' }]
    default: return []
  }
}
