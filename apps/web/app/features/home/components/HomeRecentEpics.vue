<script setup lang="ts">
import type { Epic, Project } from '@corral/contracts'

// The parent tasks touched most recently, across projects
defineProps<{ epics: { epic: Epic, project: Project & { color: string } }[] }>()
</script>

<template>
  <ul
    v-if="epics.length"
    class="flex flex-col gap-4"
    data-testid="home-recent-epics"
  >
    <li
      v-for="{ epic, project } in epics"
      :key="epic.id"
      class="flex flex-col gap-1"
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
    </li>
  </ul>
  <p
    v-else
    class="text-sm text-muted-foreground"
  >
    No tasks with subtasks yet.
  </p>
</template>
