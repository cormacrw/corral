<script setup lang="ts">
import { useMutation } from '@tanstack/vue-query'
import type { Epic } from '@corral/contracts'
import type { EpicReviewMode } from '@corral/core'
import { patchEpic } from '~/queries/epics'
import { EPIC_REVIEW_MODE, epicReviewStatus } from '~/utils/labels'

// The delivery state of a task in a collapsed one-task epic (D31): it has no
// parent page, so its PR, sync state and review mode show on the task.
const props = defineProps<{ epic: Epic }>()
const patch = useMutation(patchEpic)
const modes = (Object.keys(EPIC_REVIEW_MODE) as EpicReviewMode[]).map(value => ({ value, label: EPIC_REVIEW_MODE[value].label }))
const status = computed(() => epicReviewStatus(props.epic))
</script>

<template>
  <section
    class="flex flex-col gap-2 text-sm"
    data-testid="task-delivery"
  >
    <h3 class="font-medium">
      Delivery
    </h3>
    <EpicPrBlock :epic="epic" />
    <p
      v-if="status"
      class="text-xs text-muted"
    >
      {{ status.label }}
    </p>
    <EpicFixAlert
      v-if="epic.sync?.state === 'fixing'"
      :sync="epic.sync"
    />
    <USelect
      v-if="!(epic.prUrl && epic.reviewMode !== 'direct')"
      :model-value="epic.reviewMode"
      :items="modes"
      :disabled="epic.reviewModeLocked"
      aria-label="Review mode"
      class="w-full"
      @update:model-value="patch.mutate({ id: epic.id, input: { reviewMode: $event as EpicReviewMode } })"
    />
  </section>
</template>
