import type { InboxItem, PlanThreadItem } from '@corral/contracts'
import type { Tone } from '~/lib/tone'

// What each kind of Inbox item is (design/inbox.md), in one place: the word
// before its subject in the list, its badge, the line above its subject in
// its pane, and which pane shows it. A new kind is one entry here.

// What an item is, for the line above its subject
export interface InboxItemKind {
  label: string
  icon: string
  color: string
}

// Which pane shows the item. Task items share the task panel; the rest have
// panes of their own.
type InboxPane = 'task' | 'epic' | 'plan_thread' | 'release_notes' | 'runner_update'

interface KindEntry {
  // Before the subject in the list; empty when the subject says it already
  prefix: string
  badge: { label: string, color: Tone }
  kind: InboxItemKind
  pane: InboxPane
}

export const RESOLVED_KIND: InboxItemKind = { label: 'Resolved', icon: 'i-hugeicons-checkmark-circle-02', color: 'text-success' }

const ACTIVITY: InboxItemKind = { label: 'Activity', icon: 'i-hugeicons-pulse-01', color: 'text-muted-foreground' }

const KINDS: Record<InboxItem['type'], KindEntry> = {
  human_review: { prefix: 'Task Review', badge: { label: 'Human review', color: 'warning' }, kind: { label: 'Human review', icon: 'i-hugeicons-git-pull-request', color: 'text-brand' }, pane: 'task' },
  question: { prefix: 'Question', badge: { label: 'Question', color: 'info' }, kind: { label: 'Question', icon: 'i-hugeicons-help-circle', color: 'text-info' }, pane: 'task' },
  blocked: { prefix: 'Blocked', badge: { label: 'Blocked', color: 'error' }, kind: { label: 'Blocked', icon: 'i-hugeicons-pause-circle', color: 'text-warning' }, pane: 'task' },
  failed: { prefix: 'Failed', badge: { label: 'Failed', color: 'error' }, kind: { label: 'Failed', icon: 'i-hugeicons-cancel-circle', color: 'text-destructive' }, pane: 'task' },
  stopped: { prefix: 'Stopped', badge: { label: 'Stopped', color: 'warning' }, kind: { label: 'Stopped', icon: 'i-hugeicons-stop-circle', color: 'text-warning' }, pane: 'task' },
  activity: { prefix: 'Activity', badge: { label: 'Activity', color: 'neutral' }, kind: ACTIVITY, pane: 'task' },
  plan_thread: { prefix: 'Plan Review', badge: { label: 'Plan', color: 'primary' }, kind: { label: 'Plan review', icon: 'i-hugeicons-task-done-01', color: 'text-brand' }, pane: 'plan_thread' },
  epic_review: { prefix: 'Task Review', badge: { label: 'Task\'s PR', color: 'warning' }, kind: { label: 'Task review', icon: 'i-hugeicons-git-pull-request', color: 'text-brand' }, pane: 'epic' },
  epic_conflict: { prefix: 'Conflict', badge: { label: 'Task conflict', color: 'error' }, kind: { label: 'Task conflict', icon: 'i-hugeicons-git-merge', color: 'text-destructive' }, pane: 'epic' },
  epic_activity: { prefix: 'Activity', badge: { label: 'Task\'s PR', color: 'neutral' }, kind: { label: 'Task\'s PR', icon: 'i-hugeicons-pulse-01', color: 'text-muted-foreground' }, pane: 'epic' },
  release_notes: { prefix: '', badge: { label: 'Release notes', color: 'neutral' }, kind: ACTIVITY, pane: 'release_notes' },
  runner_update: { prefix: 'Runner Update', badge: { label: 'Runner', color: 'error' }, kind: ACTIVITY, pane: 'runner_update' }
}

// A Plan thread is whatever its PM's turn left waiting
const PLAN_THREAD: Record<Exclude<PlanThreadItem['status'], 'needs_approval'>, Pick<KindEntry, 'prefix' | 'kind'>> = {
  question: { prefix: 'Question', kind: KINDS.question.kind },
  failed: { prefix: 'Failed', kind: KINDS.failed.kind }
}
type KindOf = Pick<InboxItem, 'type'> & { status?: string }
const entry = (item: KindOf): Pick<KindEntry, 'prefix' | 'kind'> =>
  item.type === 'plan_thread' && item.status && item.status in PLAN_THREAD ? PLAN_THREAD[item.status as keyof typeof PLAN_THREAD] : KINDS[item.type]

export const inboxPrefix = (item: KindOf) => entry(item).prefix
export const inboxKind = (item: KindOf) => entry(item).kind
const inboxPane = (item: Pick<InboxItem, 'type'>) => KINDS[item.type].pane
export const isOwnPane = (item: Pick<InboxItem, 'type'> | null) => item !== null && inboxPane(item) !== 'task'
// A Plan thread is read by its session as it shows, release notes by their
// deployment; opening reads every other item
export const readsOnOpen = (item: Pick<InboxItem, 'type'>) => inboxPane(item) !== 'plan_thread' && inboxPane(item) !== 'release_notes'

export const inboxBadge = (item: Pick<InboxItem, 'type'>) => KINDS[item.type].badge
