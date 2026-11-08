<script setup lang="ts">
import { projectPath } from '~/utils/routes'
import type { DetailMode } from '~/composables/useTaskFlyout'
import type { EpicDetail, Project } from '@corral/contracts'

// What names an epic in its header, for each mode
defineProps<{ mode: DetailMode, epic: EpicDetail | null, project: Project | null, saved: boolean }>()
</script>

<template>
  <template v-if="mode === 'flyout'">
    <AppBadge
      label="Task"
      color="neutral"
      variant="subtle"
      size="sm"
    />
    <span class="min-w-0 truncate text-sm text-muted-foreground">{{ project?.name }}</span>
  </template>
  <template v-else-if="mode === 'mobile'">
    <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
      <AppBadge
        label="Task"
        color="neutral"
        variant="subtle"
        size="sm"
      />
      <span class="truncate">{{ project?.name }}</span>
    </div>
    <h1 class="flex items-center gap-2 text-base font-semibold text-foreground">
      <span class="min-w-0 truncate">{{ epic?.title ?? 'Task' }}</span>
      <span
        v-if="saved"
        class="shrink-0 text-xs font-normal text-success"
      >✓ Saved</span>
    </h1>
  </template>
  <AppBreadcrumb
    v-else
    :items="[{ label: project?.name ?? 'Project', to: project ? projectPath(project.slug) : '/' }, { label: epic?.title ?? 'Task' }]"
  />
</template>
