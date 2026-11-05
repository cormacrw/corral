<script setup lang="ts">
import type { EpicDetail } from '@corral/contracts'
import type { EpicReviewMode } from '@corral/core'
import { EPIC_REVIEW_MODE } from '~/utils/labels'

// How an epic is reviewed: its PR once it has one, its review mode until then
defineProps<{ epic: EpicDetail }>()
defineEmits<{ change: [mode: EpicReviewMode] }>()
const reviewModes = Object.entries(EPIC_REVIEW_MODE).map(([value, mode]) => ({ value, label: mode.label }))
</script>

<template>
  <section class="space-y-2">
    <h3 class="text-sm font-medium">
      Review
    </h3>
    <EpicPrBlock
      v-if="epic.prUrl && epic.reviewMode !== 'direct'"
      :epic="epic"
    />
    <template v-else>
      <AppSelect
        :model-value="epic.reviewMode"
        :items="reviewModes"
        :disabled="epic.reviewModeLocked"
        aria-label="Subtask review mode"
        :aria-describedby="epic.reviewModeLocked ? 'epic-review-mode-note' : undefined"
        class="w-full"
        @update:model-value="$emit('change', $event as EpicReviewMode)"
      />
      <p
        v-if="epic.reviewModeLocked"
        id="epic-review-mode-note"
        class="text-xs text-muted-foreground"
      >
        Locked because a subtask has submitted work.
      </p>
      <p
        v-else
        class="text-xs text-muted-foreground"
      >
        {{ EPIC_REVIEW_MODE[epic.reviewMode].description }}. You can change this until a task opens a PR.
      </p>
      <p
        v-if="epic.reviewMode !== 'direct'"
        class="text-xs text-muted-foreground"
      >
        The task's PR opens once every subtask is complete. Human checks are confirmed there.
      </p>
    </template>
  </section>
</template>
