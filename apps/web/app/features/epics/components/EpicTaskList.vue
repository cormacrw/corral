<script setup lang="ts">
import type { Task } from '@corral/contracts'
import { PRIORITY, priorityText } from '~/utils/labels'

// An epic's tasks, each opening on click. `roomy` is a phone's tap target.
defineProps<{ tasks: Task[], selected: string | null, roomy?: boolean }>()
defineEmits<{ open: [ref: string] }>()
</script>

<template>
  <ul>
    <li
      v-for="task in tasks"
      :key="task.id"
    >
      <button
        type="button"
        :aria-pressed="selected === task.ref"
        :class="['flex w-full items-center gap-2 rounded-md px-2 text-start text-sm hover:bg-muted', roomy ? 'min-h-11 py-2.5' : 'py-2', selected === task.ref && 'bg-muted']"
        @click="$emit('open', task.ref)"
      >
        <span class="w-14 shrink-0 font-mono text-xs text-muted-foreground">{{ task.ref }}</span>
        <span class="min-w-0 flex-1 truncate">{{ task.title }}</span>
        <span
          v-if="task.dependsOn.length"
          class="hidden shrink-0 text-xs text-muted-foreground sm:inline"
        >after {{ task.dependsOn.join(', ') }}</span>
        <span
          v-if="task.priority === 'urgent' || task.priority === 'high'"
          :class="['shrink-0 text-xs', priorityText(task)]"
        >{{ PRIORITY[task.priority].label }}</span>
        <StatusBadge
          :status="task.status"
          size="xs"
        />
      </button>
      <TaskCommitLinks
        v-if="task.submission"
        :task="task"
        class="px-2 pb-1 text-xs"
      />
    </li>
  </ul>
</template>
