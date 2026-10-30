<script setup lang="ts">
import type { Epic } from '@corral/contracts'
import { EPIC_REVIEW_MODE, EPIC_STATUS_TEXT, epicReviewStatus } from '~/utils/labels'

// An epic's review mode, what its review is waiting on and its PR (D27)
const props = defineProps<{ epic: Epic }>()
const status = computed(() => epicReviewStatus(props.epic))
</script>

<template>
  <div class="mt-1.5 text-xs">
    <div class="flex flex-wrap items-center justify-between gap-x-2 gap-y-0.5">
      <span
        class="text-muted"
        :title="EPIC_REVIEW_MODE[epic.reviewMode].description"
      >Review: {{ EPIC_REVIEW_MODE[epic.reviewMode].label }}</span>
      <a
        v-if="epic.prUrl"
        :href="epic.prUrl"
        target="_blank"
        rel="noopener"
        class="text-primary hover:underline"
      >Epic PR #{{ epic.prNumber }}</a>
    </div>
    <p
      v-if="status"
      :class="['mt-0.5 font-medium', EPIC_STATUS_TEXT[status.color]]"
    >
      {{ status.label }}
    </p>
  </div>
</template>
