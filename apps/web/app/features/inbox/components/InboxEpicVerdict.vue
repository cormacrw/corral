<script setup lang="ts">
import type { EpicInboxItem } from '~/features/inbox/composables/useInboxView'
import type { InboxEpicReview } from '~/features/inbox/composables/useInboxEpicReview'
import { verdictMark } from '~/features/inbox/utils/inbox-summary'

// An epic review's verdict in one line: the reviewer, the gates, the tasks merged
// and how many of them the human has seen
const props = defineProps<{ item: EpicInboxItem, r: InboxEpicReview }>()

// What the review said about this head. A reviewer sends the item only when
// integration was approved: a review that stopped or a refused merge comes from
// Corral, and an older round's approval says nothing about them.
const verdict = computed(() => {
  const round = props.r.rounds.value.find(r => r.headSha === props.r.viewedHead.value)
  if (round?.verdict === 'changes_requested') return { text: 'requested changes', name: round.reviewer.name, ok: false }
  if (props.item.sender.role !== 'reviewer') return { text: 'No reviewer approval on this head', name: null, ok: false }
  return { text: 'approved the task', name: round?.reviewer.name ?? props.item.sender.name, ok: true }
})
const mark = computed(() => verdictMark(verdict.value.ok))
const gates = computed(() => props.r.review.value?.gateChecks ?? [])
const gatesPassed = computed(() => gates.value.length > 0 && gates.value.every(g => g.conclusion === 'success'))
const saw = computed(() => {
  const { review, rows } = props.r
  if (!review.value || rows.value.length === 0) return null
  return review.value.seenByHuman === rows.value.length ? 'You saw all' : `You saw ${review.value.seenByHuman} of ${rows.value.length}`
})
</script>

<template>
  <div
    class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-sm text-muted-foreground"
    data-testid="inbox-epic-verdict"
  >
    <span
      class="flex items-center gap-1.5"
      data-testid="inbox-epic-reviewer"
    >
      <Icon
        :name="mark.icon"
        :class="['size-4 shrink-0', mark.color]"
      />
      <span><span
        v-if="verdict.name"
        class="font-medium text-foreground"
      >{{ verdict.name }}</span>{{ verdict.name ? ' ' : '' }}{{ verdict.text }}</span>
    </span>
    <UiSkeleton
      v-if="r.loading.value"
      class="h-5 w-56"
      data-testid="inbox-verdict-loading"
    />
    <template v-else-if="r.review.value">
      <template v-if="gates.length">
        <span aria-hidden="true">·</span>
        <span>{{ gates.map(g => g.name).join(', ') }} {{ gatesPassed ? 'passed' : 'not passed yet' }}</span>
      </template>
      <span aria-hidden="true">·</span>
      <span>{{ r.merged.value }} of {{ r.rows.value.length }} {{ r.rows.value.length === 1 ? 'task' : 'tasks' }} merged</span>
      <template v-if="saw">
        <span aria-hidden="true">·</span>
        <span class="font-medium text-foreground">{{ saw }}</span>
      </template>
    </template>
  </div>
</template>
