<script setup lang="ts">
import type { Epic, Task } from '@corral/contracts'
import { STATUS } from '~/utils/labels'

defineProps<{ group: { id: string, title: string, merged: number, total: number, epic?: Epic }, tasks: Task[] }>()
const expanded = ref(false)
</script>

<template>
  <article class="rounded-lg border border-default p-3">
    <div class="flex items-start gap-3">
      <div class="min-w-0 flex-1">
        <EpicProgressRow v-bind="group" />
      </div>
      <UButton
        :icon="expanded ? 'i-lucide-chevron-up' : 'i-lucide-chevron-down'"
        :aria-label="`${expanded ? 'Collapse' : 'Expand'} ${group.title}`"
        :aria-expanded="expanded"
        :aria-controls="`epic-tasks-${group.id}`"
        color="neutral"
        variant="ghost"
        class="min-h-11 min-w-11"
        @click="expanded = !expanded"
      />
    </div>
    <div
      v-if="expanded"
      :id="`epic-tasks-${group.id}`"
      class="mt-3 border-t border-default pt-2"
    >
      <ul class="divide-y divide-default">
        <li
          v-for="task in tasks"
          :key="task.id"
        >
          <NuxtLink
            :to="`/tasks/${task.ref}`"
            class="flex flex-wrap items-center gap-2 rounded px-1 py-3 text-sm hover:bg-elevated"
          >
            <span class="font-mono text-xs text-muted">{{ task.ref }}</span>
            <span class="min-w-0 flex-1">{{ task.title }}</span>
            <UBadge
              :label="STATUS[task.status].label"
              :color="STATUS[task.status].color"
              variant="subtle"
              size="sm"
            />
          </NuxtLink>
        </li>
      </ul>
      <p
        v-if="tasks.length === 0"
        class="text-sm text-muted"
      >
        No tasks in this parent yet.
      </p>
    </div>
  </article>
</template>
