<script setup lang="ts">
import type { Project, Run } from '@corral/contracts'
import { projectColor, runRef, runTitle } from '~/utils/labels'

// A run's lines in the mobile agent page's lists. `tabular`: `when` is a ticking timer.
defineProps<{ run: Run, project: Project | null, detail: string, when: string, tabular?: boolean }>()
</script>

<template>
  <span class="flex items-center gap-2">
    <span class="font-mono text-xs text-muted-foreground">{{ runRef(run) }}</span>
    <span :class="['ms-auto text-xs text-muted-foreground', tabular && 'tabular-nums']">{{ when }}</span>
  </span>
  <span class="truncate font-medium text-foreground">{{ runTitle(run) }}</span>
  <span class="flex items-center gap-1.5 text-xs text-muted-foreground">
    <span
      v-if="project"
      class="size-2 shrink-0 rounded-full"
      :style="{ backgroundColor: projectColor(project) }"
      aria-hidden="true"
    />
    {{ detail }}
  </span>
</template>
