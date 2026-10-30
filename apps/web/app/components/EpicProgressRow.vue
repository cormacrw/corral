<script setup lang="ts">
import type { Epic } from '@corral/contracts'

// With an epic, the row also shows its review mode, review state and PR
defineProps<{ id: string, title: string, merged: number, total: number, epic?: Epic }>()
</script>

<template>
  <div>
    <div class="flex justify-between gap-2 text-sm">
      <NuxtLink
        v-if="id !== 'none'"
        :to="`/epics/${id}`"
        class="truncate font-medium"
      >{{ title }}</NuxtLink>
      <span
        v-else
        class="truncate font-medium"
      >{{ title }}</span>
      <span class="shrink-0 text-xs text-muted">{{ merged }} of {{ total }} merged</span>
    </div>
    <div
      role="meter"
      :aria-label="`${title}: ${merged} of ${total} tasks merged`"
      :aria-valuenow="merged"
      aria-valuemin="0"
      :aria-valuemax="total"
      class="mt-1.5 flex h-1.5 gap-0.5"
    >
      <span
        class="rounded-full bg-primary"
        :style="{ flex: merged }"
      />
      <span
        class="rounded-full bg-accented"
        :style="{ flex: total - merged }"
      />
    </div>
    <EpicReviewLine
      v-if="epic"
      :epic="epic"
    />
  </div>
</template>
