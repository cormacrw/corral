import type { InboxItem } from '@corral/contracts'

// What an Inbox item is, said before its subject in the list: Task Review,
// Question, Plan Review and so on. Empty when the subject says it already.
export function inboxTitlePrefix(item: Pick<InboxItem, 'type'> & { status?: string }): string {
  switch (item.type) {
    case 'human_review': return 'Task Review'
    case 'question': return 'Question'
    case 'blocked': return 'Blocked'
    case 'failed': return 'Failed'
    case 'stopped': return 'Stopped'
    case 'plan_thread': return item.status === 'question' ? 'Question' : item.status === 'failed' ? 'Failed' : 'Plan Review'
    case 'epic_review': return 'Task Review'
    case 'epic_conflict': return 'Conflict'
    // Its subject already says what it is
    case 'release_notes': return ''
    case 'runner_update': return 'Runner Update'
    default: return 'Activity'
  }
}
