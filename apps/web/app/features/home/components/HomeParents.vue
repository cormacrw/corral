<script setup lang="ts">
import type { Epic, Project } from '@corral/contracts'
import { projectColor } from '~/utils/labels'

defineProps<{ epics: { epic: Epic, project: Project }[], showProject: boolean }>()
</script>

<template>
  <section
    class="flex flex-col gap-2"
    data-testid="home-epics"
  >
    <h2 class="text-sm font-semibold text-foreground">
      Tasks with subtasks
    </h2>
    <ul
      v-if="epics.length"
      class="flex flex-col gap-3"
    >
      <li
        v-for="{ epic, project } in epics"
        :key="epic.id"
      >
        <p
          v-if="showProject"
          class="mb-1 flex items-center gap-1.5 text-xs text-muted-foreground"
        >
          <span
            class="size-2 shrink-0 rounded-full"
            :style="{ background: projectColor(project) }"
            aria-hidden="true"
          />
          {{ project.name }}
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
      No tasks with subtasks in progress.
    </p>
  </section>
</template>
