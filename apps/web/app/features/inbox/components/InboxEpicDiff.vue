<script setup lang="ts">
import type { PullRequestDetail } from '@corral/contracts'
import type { InboxEpicReview } from '~/features/inbox/composables/useInboxEpicReview'

// The Code diff tab of an epic: its whole diff, or what changed since the human's
// last review. A first review has only the whole epic.
const props = defineProps<{ pr: PullRequestDetail, r: InboxEpicReview }>()
const view = defineModel<'since' | 'whole'>('view', { required: true })

const feedback = computed(() => props.r.feedback.value)
const showing = computed(() => feedback.value ? view.value : 'whole')
const diff = computed<PullRequestDetail>(() => {
  if (showing.value === 'whole' || !feedback.value) return props.pr
  const { files, totalFiles, truncated } = feedback.value
  return { ...props.pr, files, totalFiles, truncated }
})
const VIEWS = [{ value: 'since', label: 'Since your last review' }, { value: 'whole', label: 'Whole parent' }] as const
</script>

<template>
  <div class="flex flex-col gap-3">
    <div
      v-if="feedback"
      class="flex flex-wrap gap-1"
      role="group"
      aria-label="Which changes to show"
      data-testid="inbox-diff-view"
    >
      <AppButton
        v-for="option in VIEWS"
        :key="option.value"
        :label="option.label"
        size="xs"
        :color="showing === option.value ? 'primary' : 'neutral'"
        :variant="showing === option.value ? 'subtle' : 'ghost'"
        :aria-pressed="showing === option.value"
        @click="view = option.value"
      />
    </div>
    <AppAlert
      v-if="showing === 'since' && r.sinceUnavailable.value"
      color="warning"
      variant="subtle"
      title="Couldn't work out what changed since your review"
      :actions="feedback?.diffUrl ? [{ label: 'Compare on GitHub', to: feedback.diffUrl, target: '_blank', trailingIcon: 'i-ri-arrow-right-up-line' }] : []"
      data-testid="inbox-since-unavailable"
    />
    <p
      v-else-if="showing === 'since' && diff.totalFiles === 0"
      class="text-sm text-muted-foreground"
    >
      Nothing has changed since the head you reviewed.
    </p>
    <InboxPanelDiff
      v-else
      :key="showing"
      :pr="diff"
      :github-url="showing === 'since' ? feedback?.diffUrl ?? undefined : undefined"
    />
  </div>
</template>
