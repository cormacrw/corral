<script setup lang="ts">
import { TONE_TEXT } from '~/lib/tone'
import type { PullRequestRow } from '~/features/projects/composables/usePullRequests'

// Whether a PR can merge, and why not
const props = defineProps<{ row: PullRequestRow }>()
const icon = computed(() => {
  const { merge, humanReviewOutstanding } = props.row.pr
  return merge.eligible ? (humanReviewOutstanding ? 'i-ri-time-line' : 'i-ri-git-merge-line') : 'i-ri-close-circle-line'
})
</script>

<template>
  <span :class="['flex items-start gap-1.5', TONE_TEXT[row.merge.color]]">
    <Icon
      :name="icon"
      class="mt-0.5 size-4 shrink-0"
    />
    <span>
      {{ row.merge.label }}
      <span
        v-if="row.merge.detail"
        class="block text-xs text-muted-foreground"
      >{{ row.merge.detail }}</span>
    </span>
  </span>
</template>
