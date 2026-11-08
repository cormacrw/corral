<script setup lang="ts">
import TimeAgo from '~/components/shared/TimeAgo.vue'

// A Board card's muted detail line: its ref, its PR and when it last changed
defineProps<{ taskRef: string | null, prNumber: number | null, at: string }>()
</script>

<template>
  <span
    class="flex min-w-0 items-center gap-1.5 text-xs text-muted-foreground"
    data-testid="card-meta"
  >
    <span
      v-if="taskRef"
      class="shrink-0 font-mono"
    >{{ taskRef }}</span>
    <span
      v-if="prNumber"
      class="flex shrink-0 items-center gap-0.5"
    >
      <Icon
        name="i-ri-git-pull-request-line"
        class="size-3"
      />#{{ prNumber }}
    </span>
    <span class="ms-auto shrink-0"><TimeAgo :at="at" /></span>
  </span>
</template>
