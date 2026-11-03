<script setup lang="ts">
import type { PlanSession, Project } from '@corral/contracts'
import { projectColor, runtimeLabel } from '~/utils/labels'

// A conversation's header on the web. `closable`: the session exists on the server.
defineProps<{ session: PlanSession | null, project: Project | null, closable: boolean }>()
</script>

<template>
  <header class="flex h-14 shrink-0 items-center gap-2 border-b border-border px-4 text-sm">
    <span
      v-if="project"
      class="size-2.5 shrink-0 rounded-full"
      :style="{ background: projectColor(project) }"
    />
    <span class="max-w-48 shrink-0 truncate text-muted-foreground">{{ project?.name ?? 'Global' }}</span>
    <span class="truncate font-medium">{{ session?.title }}</span>
    <AppBadge
      v-if="session"
      :label="runtimeLabel(session.runtime)"
      variant="subtle"
      color="neutral"
      size="sm"
      data-testid="plan-session-runtime"
    />
    <div class="ms-auto flex shrink-0 items-center gap-2">
      <PlanCloseThread
        v-if="session && closable"
        :session="session"
      />
      <AppButton
        to="/plan"
        label="New session"
        variant="ghost"
        color="neutral"
        size="sm"
      />
    </div>
  </header>
</template>
