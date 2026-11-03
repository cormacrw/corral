<script setup lang="ts">
import type { EpicDetail, Project } from '@corral/contracts'

// What names an epic in its header, for each mode
defineProps<{ mode: 'flyout' | 'page' | 'mobile', epic: EpicDetail | null, project: Project | null, saved: boolean }>()
</script>

<template>
  <template v-if="mode === 'flyout'">
    <AppBadge
      label="Parent"
      color="neutral"
      variant="subtle"
      size="sm"
    />
    <span class="min-w-0 truncate text-sm text-muted-foreground">{{ project?.name }}</span>
  </template>
  <template v-else-if="mode === 'mobile'">
    <div class="flex items-center gap-1.5 text-xs text-muted-foreground">
      <AppBadge
        label="Parent"
        color="neutral"
        variant="subtle"
        size="sm"
      />
      <span class="truncate">{{ project?.name }}</span>
    </div>
    <h1 class="flex items-center gap-2 text-base font-semibold text-foreground">
      <span class="min-w-0 truncate">{{ epic?.title ?? 'Parent' }}</span>
      <span
        v-if="saved"
        class="shrink-0 text-xs font-normal text-success"
      >✓ Saved</span>
    </h1>
  </template>
  <AppBreadcrumb
    v-else
    :items="[{ label: project?.name ?? 'Project', to: project ? `/projects/${project.slug}` : '/' }, { label: epic?.title ?? 'Parent' }]"
  />
</template>
