<script setup lang="ts">
import type { Task } from '@corral/contracts'

// Where a task's work is: its PR, or without one the commits Corral recorded
// (D27). Integrated is on the epic branch; until then, the latest submission.
const props = defineProps<{ task: Pick<Task, 'prNumber' | 'prUrl' | 'submission'> }>()
const short = (sha: string) => sha.slice(0, 10)
const integrated = computed(() => props.task.submission?.integrated ?? null)
const reviewed = computed(() => props.task.submission?.approved ?? props.task.submission?.submitted ?? null)
</script>

<template>
  <span class="flex flex-wrap items-center gap-x-3 gap-y-1 text-sm">
    <a
      v-if="task.prUrl"
      :href="task.prUrl"
      target="_blank"
      rel="noopener"
      class="text-primary hover:underline"
    >Task PR #{{ task.prNumber }}</a>
    <template v-else>
      <a
        v-if="integrated"
        :href="integrated.url"
        target="_blank"
        rel="noopener"
        class="text-primary hover:underline"
      >Integrated <span class="font-mono text-xs">{{ short(integrated.sha) }}</span></a>
      <a
        v-if="reviewed"
        :href="reviewed.url"
        target="_blank"
        rel="noopener"
        class="text-primary hover:underline"
      >{{ task.submission?.approved ? 'Approved' : 'Submitted' }} <span class="font-mono text-xs">{{ short(reviewed.sha) }}</span></a>
    </template>
  </span>
</template>
