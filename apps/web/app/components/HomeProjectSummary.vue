<script setup lang="ts">
import type { Project, Task } from '@corral/contracts'
import { dashboardCounts } from '~/utils/dashboard'
import { projectColor } from '~/utils/labels'

const props = defineProps<{ project: Project, tasks: Task[] }>()
const counts = computed(() => dashboardCounts(props.tasks))
const backlog = computed(() => props.tasks.filter(t => t.status === 'backlog').length)
</script>

<template>
  <NuxtLink
    :to="`/projects/${project.slug}/board`"
    class="block rounded-lg border border-default p-4 transition-colors hover:bg-elevated"
  >
    <h3 class="flex items-center gap-2 font-semibold text-highlighted">
      <span
        class="size-2 rounded-full"
        :style="{ background: projectColor(project) }"
        aria-hidden="true"
      />
      {{ project.name }}
      <UIcon
        name="i-lucide-arrow-up-right"
        class="ms-auto size-4 text-muted"
      />
    </h3>
    <p class="mt-2 text-sm"><strong class="text-xl font-semibold text-highlighted">{{ counts.inProgress }}</strong> <span class="text-muted">in progress</span></p>
    <p class="mt-1 text-xs text-muted">{{ counts.stages.in_progress }} building · {{ counts.stages.agent_review }} agent review<br>{{ counts.stages.human_review }} human review · {{ counts.stages.ready_to_merge }} to merge</p>
    <p class="mt-2 text-sm">
      <span :class="counts.blocked ? 'text-error' : 'text-muted'">{{ counts.blocked }} blocked / failed</span> ·
      <span :class="counts.waitingForReview ? 'text-warning' : 'text-muted'">{{ counts.waitingForReview }} need review</span>
    </p>
    <p class="mt-1 text-xs text-muted">{{ backlog }} backlog · {{ counts.mergedToday }} merged today</p>
  </NuxtLink>
</template>
