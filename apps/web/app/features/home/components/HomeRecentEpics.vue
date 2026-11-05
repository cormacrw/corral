<script setup lang="ts">
import type { Epic, Project } from '@corral/contracts'

// The parent tasks touched most recently, across projects
defineProps<{ epics: { epic: Epic, project: Project & { color: string } }[], mobile?: boolean }>()
</script>

<template>
  <ul
    v-if="epics.length"
    class="flex flex-col"
    :class="mobile ? 'gap-2' : 'gap-4'"
    data-testid="home-recent-epics"
  >
    <li
      v-for="{ epic, project } in epics"
      :key="epic.id"
      :class="['flex flex-col gap-1', mobile && 'relative -mx-2 min-h-11 rounded-lg px-2 py-1.5 active:bg-muted']"
    >
      <p class="flex items-center gap-1.5 text-xs text-muted-foreground">
        <span
          class="size-2 shrink-0 rounded-full"
          :style="{ background: project.color }"
          aria-hidden="true"
        />
        <span class="truncate">{{ project.name }}</span>
        <span
          v-if="epic.taskRef"
          class="font-mono"
        >· {{ epic.taskRef }}</span>
        <span class="ms-auto shrink-0"><TimeAgo :at="epic.updatedAt" /></span>
      </p>
      <EpicProgressRow
        :id="epic.id"
        :title="epic.title"
        :merged="epic.mergedCount"
        :total="epic.taskCount"
        :epic="epic"
      />
      <NuxtLink
        v-if="mobile"
        :to="`/epics/${epic.id}`"
        :aria-label="epic.title"
        class="absolute inset-0 rounded-lg"
      />
    </li>
  </ul>
  <p
    v-else
    class="text-sm text-muted-foreground"
  >
    No parent tasks yet.
  </p>
</template>
