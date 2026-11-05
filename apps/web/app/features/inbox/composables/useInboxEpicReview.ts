import type { EpicReviewTaskRow } from '@corral/contracts'
import { isTaskDone } from '@corral/core'
import { useQuery, useQueryClient } from '@tanstack/vue-query'
import type { InboxItemKind } from '~/features/inbox/composables/useInboxPanel'
import type { EpicInboxItem } from '~/features/inbox/composables/useInboxView'
import { epicReviewQuery } from '~/queries/epics'
import { keys } from '~/queries/keys'
import { plural } from '~/utils/labels'

// What an epic in the Inbox shows (design/inbox.md): its review, falling back on
// what the item itself carries while the review loads or if it can't.
export function useInboxEpicReview(props: { item: EpicInboxItem }) {
  const client = useQueryClient()
  const result = useQuery(computed(() => epicReviewQuery(props.item.epicId)))
  const review = computed(() => result.data.value ?? null)
  const loading = computed(() => result.isPending.value)
  const refresh = () => client.resetQueries({ queryKey: keys.epics.review(props.item.epicId), exact: true })

  // Before the review arrives, or if it can't, an item waiting on the human
  // already has its tasks, so owed checks can still be ticked
  const fromItem = computed<EpicReviewTaskRow[]>(() => props.item.type !== 'epic_review'
    ? []
    : props.item.tasks.map(({ task, evidence, humanReview, humanChecks }) => ({
        id: task.id, ref: task.ref, title: task.title, kind: task.kind, merged: isTaskDone(task),
        prNumber: task.pr?.number ?? null, prUrl: task.pr?.url ?? null, integratedCommit: task.submission?.integrated ?? null,
        reviewedBy: null, criteria: task.acceptanceCriteria, criteriaMet: task.acceptanceCriteria.filter(c => c.met === true).length,
        criteriaTotal: task.acceptanceCriteria.length, evidence, humanReview, humanChecks
      })))
  const rows = computed(() => review.value?.tasks ?? fromItem.value)
  const merged = computed(() => rows.value.filter(r => r.merged).length)
  // Newest first. The item has them too, so Review works if the review can't load
  const rounds = computed(() => review.value?.rounds ?? (props.item.type === 'epic_review' ? [...props.item.reviewRounds].reverse() : []))

  const canAct = computed(() => props.item.type !== 'epic_activity' && !props.item.resolution)
  // The head the human is looking at. The item can update first, and approving
  // must not vouch for a head whose diff and gates never reached the screen.
  const viewedHead = computed(() => review.value?.headSha ?? (props.item.type === 'epic_activity' ? null : props.item.headSha))

  const kind = computed<InboxItemKind>(() => {
    const { item } = props
    if (item.resolution) return { label: 'Resolved', icon: 'i-hugeicons-checkmark-circle-02', color: 'text-success' }
    if (item.type === 'epic_review') return { label: 'Task review', icon: 'i-hugeicons-git-pull-request', color: 'text-brand' }
    if (item.type === 'epic_conflict') {
      if (item.stopped) return { label: item.stopped.fix === 'ci' || item.stopped.fix === 'review' ? 'Fix stopped' : 'Rebase stopped', icon: 'i-hugeicons-stop-circle', color: 'text-destructive' }
      return item.decision
        ? { label: 'Rebase decision', icon: 'i-hugeicons-help-circle', color: 'text-info' }
        : { label: 'Task conflict', icon: 'i-hugeicons-git-merge', color: 'text-destructive' }
    }
    return { label: 'Task\'s PR', icon: 'i-hugeicons-pulse-01', color: 'text-muted-foreground' }
  })

  const target = computed(() => review.value?.targetBranch ?? (props.item.type === 'epic_conflict' ? props.item.targetBranch : null))
  // A note under the actions, because this one reaches the target branch
  const approvalNote = computed(() => {
    const name = target.value ?? 'the target branch'
    const moved = review.value?.targetMovedBy ?? 0
    if (review.value?.conflictPending) return `This task conflicts with ${name}. Approving sends the conflict to a developer, then runs CI and squash-merges.`
    return moved > 0
      ? `${name} has moved ${plural(moved, 'commit')}. Approving rebases onto it, runs CI and squash-merges.`
      : `Approving runs CI and squash-merges into ${name}.`
  })
  const conflictTask = computed(() => props.item.type === 'epic_activity' && props.item.event === 'conflict' ? review.value?.conflictTaskRef ?? null : null)

  // Read-only moments are history, so what's changed since doesn't apply to them
  const feedback = computed(() => canAct.value ? review.value?.lastFeedback ?? null : null)
  const sinceUnavailable = computed(() => !!feedback.value && (!feedback.value.diffUrl || (feedback.value.truncated && feedback.value.files.length === 0)))

  return { result, review, loading, refresh, rows, merged, rounds, canAct, viewedHead, kind, approvalNote, conflictTask, feedback, sinceUnavailable }
}
export type InboxEpicReview = ReturnType<typeof useInboxEpicReview>
