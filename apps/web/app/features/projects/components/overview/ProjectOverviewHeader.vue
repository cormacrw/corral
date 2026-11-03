<script setup lang="ts">
import type { Project } from '@corral/contracts'

defineProps<{ project: Project, pmName: string, mobile?: boolean }>()
</script>

<template>
  <header :class="mobile ? 'flex flex-col gap-4 px-4' : 'flex flex-wrap items-center gap-4'">
    <div :class="mobile ? 'flex items-center gap-3' : 'contents'">
      <ProjectThumbnail
        :project="project"
        :size="44"
      />
      <div :class="mobile ? 'min-w-0' : 'min-w-0 flex-1'">
        <div class="flex items-center gap-2">
          <component
            :is="mobile ? 'h2' : 'h1'"
            :class="mobile ? 'truncate text-2xl font-semibold text-foreground' : 'text-2xl font-semibold'"
          >
            {{ project.name }}
          </component>
          <AppBadge
            v-if="project.paused"
            label="Paused"
            color="warning"
            variant="subtle"
          />
        </div>
        <p
          v-if="mobile"
          class="truncate text-xs text-muted-foreground"
        >
          <span class="font-mono">github.com/{{ project.repository }}</span> · {{ project.defaultBranch }} · {{ project.prefix }}-{{ project.nextTaskNumber }}
        </p>
        <p
          v-else
          class="text-sm text-muted-foreground"
        >
          <span class="font-mono">github.com/{{ project.repository }}</span> · Branch {{ project.defaultBranch }} · Task IDs {{ project.prefix }}-{{ project.nextTaskNumber }}
        </p>
      </div>
    </div>
    <div :class="mobile ? 'grid grid-cols-2 gap-2' : 'flex gap-2'">
      <AppButton
        :to="`/plan?project=${project.id}`"
        :label="`Plan with ${pmName}`"
        variant="outline"
        color="neutral"
        icon="i-ri-message-2-line"
        :size="mobile ? 'lg' : 'md'"
        :block="mobile"
      />
      <AppButton
        :to="`/projects/${project.slug}/board`"
        label="Open board"
        :icon="mobile ? 'i-ri-kanban-view-2' : undefined"
        :size="mobile ? 'lg' : 'md'"
        :block="mobile"
      />
    </div>
  </header>
</template>
